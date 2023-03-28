// @ts-check
const { Bitbucket } = require('bitbucket')
const { Octokit } = require('@octokit/rest');

// Bitbucket authentication information
const bbUsername = ''; // Bitbucket username
const bbPassword = ''; // Bitbucket app password
const bbWorkspace = ''; // Bitbucket workspace

// GitHub authentication information
const ghUsername = ''; // GitHub username
const ghPassword = ''; // GitHub token
const ghOrg = ''; // GitHub organization. If not an organization, leave blank ('' or null) to use GitHub username
const ghTeam = ''; // GitHub organization team (not required) to add admin permission

const owner = ghOrg ? ghOrg : ghUsername;  // repository owner

const bitbucket = new Bitbucket({
  auth: {
    username: bbUsername,
    password: bbPassword
  },
});

const octokit = new Octokit({
  auth: ghPassword
});

async function getRepositoriesFromBitBucket() {
  console.log(`Searching for repositories in the workspace ${bbWorkspace}...`);
  const { data } = await bitbucket.repositories.list({ workspace: bbWorkspace, page: '2', pagelen: 1 });

  if (!data?.values?.length) {
    return console.log('No repositories found');
  }

  const repositories = data.values.map(repository => {
    return {
      repositoryName: repository.name,
      defaultBranch: repository.mainbranch?.name,
      projectName: repository.project?.name,
      description: repository.description
    }
  });

  console.log(`Found repositories: ${repositories.length}`);

  return repositories;
}

async function createRepoInOrg({ repository }) {

  const {repositoryName, projectName, defaultBranch, description} = repository;

  const targetTeamName = ghTeam;
  const topic = projectName ? projectName.toLowerCase() : null;

  const newRepositoryName = repositoryName.replace(/_/g, '-')
    .split(/(?=[A-Z])/)
    .map(s => s.toLowerCase())
    .join('-')

  console.log(`Creating repository ${newRepositoryName} on GitHub...`);

  await octokit.repos.createInOrg({
    org: ghOrg,
    name: newRepositoryName,
    private: true,
    default_branch: defaultBranch, 
    description
  });

  //add admin permission to team
  if (targetTeamName) {
    await octokit.teams.addOrUpdateRepoPermissionsInOrg({
      owner: ghOrg,
      repo: newRepositoryName,
      org: ghOrg,
      team_slug: targetTeamName,
      permission: 'admin',
    });
    console.log(`Admin permission was added for the team ${targetTeamName} on repository ${newRepositoryName}`);
  }

  //disable actions
  await octokit.request('PUT /repos/{owner}/{repo}/actions/permissions', {
    owner: ghOrg,
    enabled: false,
    repo: newRepositoryName,
  });
  console.log(`Actions disabled on repository ${newRepositoryName}`);

  await octokit.request('PUT /repos/{owner}/{repo}/topics', {
    owner: ghUsername,
    repo: newRepositoryName,
    names: [topic]
  });

  console.log(`Added topic ${topic} to repository ${newRepositoryName}`);

  console.log(`Repository successfully created!`);
  return newRepositoryName;
}

async function createRepo({ repository }) {

  const {repositoryName, projectName, defaultBranch, description} = repository;
  console.log(repositoryName, projectName, defaultBranch, description);

  const topic = projectName ? projectName.toLowerCase() : null;

  const newRepositoryName = repositoryName.replace(/_/g, '-')
    .split(/(?=[A-Z])/)
    .map(s => s.toLowerCase())
    .join('-')

  console.log(`Creating repository ${newRepositoryName} on GitHub...`);

  try {
    await octokit.repos.createForAuthenticatedUser({
      name: newRepositoryName,
      private: true,
      default_branch: defaultBranch,
      description
    });
  } catch (error) {
    console.log(`Error creating repository ${newRepositoryName} on GitHub: ${error.message}`);
    return null;
  }

  //disable actions
  await octokit.request('PUT /repos/{owner}/{repo}/actions/permissions', {
    owner: ghUsername,
    enabled: false,
    repo: newRepositoryName,
  });
  console.log(`Disabled actions for repository ${newRepositoryName}`);

  await octokit.request('PUT /repos/{owner}/{repo}/topics', {
    owner: ghUsername,
    repo: newRepositoryName,
    names: [topic]
  });

  console.log(`Added topic ${topic} to repository ${newRepositoryName}`);

  console.log(`Repository created successfully!`);
  return newRepositoryName;
}

async function importToGitHub({ repositoryName, newRepository, defaultBranch }) {

  const vcsUrl = `https://${bbUsername}@bitbucket.org/${bbWorkspace}/${repositoryName}.git`;

  const timeout = 1800000; // 30 minutos

  let importResponse = await octokit.request(`PUT /repos/${owner}/${newRepository}/import`, {
    vcs: 'git',
    vcs_url: vcsUrl,
    vcs_username: bbUsername,
    vcs_password: bbPassword,
    tfvc_project: defaultBranch
  });

  const startTime = Date.now();

  while (importResponse.data.status !== 'complete') {
    console.log(`Import status: ${importResponse.data.status}...`);
    await new Promise(resolve => setTimeout(resolve, 10000));
    importResponse = await octokit.request('GET /repos/{owner}/{repo}/import', {
      owner,
      repo: newRepository,
    })

    if (Date.now() - startTime > timeout) {
      console.log(`Timeout of ${timeout} milliseconds reached.`);
      break;
    }

    if (importResponse.data.status === 'error') {
      console.log(`Import failed: ${importResponse}`);
      break;
    }
  }

  console.log(`Import status: ${importResponse.data.status}!`);
  console.log(`Importing repository ${repositoryName} to GitHub...`);

  return importResponse.data.status === 'complete';
}

async function importPullRequests({ repositoryName, newRepository }) {
  console.log(`Importing pull requests from repository ${repositoryName} to repository ${newRepository}...`);
  // Get the list of pull requests from Bitbucket
  const { data: pullRequests } = await bitbucket.pullrequests.list({ workspace: bbWorkspace, repo_slug: repositoryName });

  if (!pullRequests?.values?.length) {
    console.log(`No pull request found for repository ${repositoryName}.`);
    return;
  }

  console.log(`Importing ${pullRequests?.values?.length} pull requests to repository ${newRepository}...`);

  // For each found Pull Request, create a new Pull Request in GitHub
  for (const pullRequest of pullRequests.values) {
    console.log(`Importing Pull Request ${pullRequest.title}...`);

    // Create new Pull Request in GitHub
    const { data: newPullRequest } = await octokit.pulls.create({
      owner,
      repo: newRepository,
      title: pullRequest.title,
      body: pullRequest.description,
      head: pullRequest.source.branch.name,
      base: pullRequest.destination.branch.name
    });

    // Add the labels from the original Pull Request to the new Pull Request
    const labels = pullRequest?.properties?.openjdk.labels?.values || [];
    if (labels.length) {
      console.log(`Adding labels: ${labels.join(', ')}...`);
      await octokit.issues.addLabels({
        owner,
        repo: newRepository,
        issue_number: newPullRequest.number,
        labels: labels,
      });
    }

    console.log(`Pull Request imported successfully!`);
  }

  //enable actions
  await octokit.request('PUT /repos/{owner}/{repo}/actions/permissions', {
    owner,
    enabled: true,
    repo: newRepository,
  });
  console.log(`Enabled actions for repository ${newRepository}`);
}

async function setDefaultBranch({ repositoryName, defaultBranch }) {
  console.log(`Updating default branch to ${defaultBranch}...`);

  await octokit.repos.update({
    owner,
    repo: repositoryName,
    name: repositoryName,
    default_branch: defaultBranch
  });

  console.log(`Default branch updated successfully!`);
  console.log('---------------------------------');
}

async function handler() {
  console.log('---------------------------------');
  console.log('Starting...');

  try {
    const repositories = await getRepositoriesFromBitBucket();

    for (const repository of repositories) {

      let newRepository = null;

      if (ghOrg) {
        newRepository = await createRepoInOrg({ repository });
      } else {
        newRepository = await createRepo({ repository });
      }

      if (!newRepository) {
        console.log(`Skipping repository ${repository.repositoryName}...`);
        continue;
      }

      const importResponse = await importToGitHub({
        repositoryName: repository.repositoryName,
        newRepository,
        defaultBranch: repository.defaultBranch
      });

      if (!importResponse) {
        console.log(`The repository ${repository.repositoryName} has not been imported yet. Skipping pull request import...`);
        continue;
      }

      await importPullRequests({
        repositoryName: repository.repositoryName,
        newRepository
      });

      await setDefaultBranch({
        repositoryName: newRepository,
        defaultBranch: repository.defaultBranch
      });
    }
    console.log('Finished!');
    return;
  } catch (error) {
    console.log(error);
  }
};

handler();
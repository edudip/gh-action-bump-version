const { Toolkit } = require('actions-toolkit')
const { execSync } = require('child_process')
const { existsSync, writeFileSync } = require('fs')
const { inc } = require('semver')

// Change working directory if user defined PACKAGEJSON_DIR
if (!process.env.VERSION_FILE) {
  console.log("VERSION_FILE not set.. trying to detect which file we should get the initial version from"
  )
  process.chdir(process.env.GITHUB_WORKSPACE)


  console.log(execSync('ls -al').toString("utf8"));
  console.log(execSync('pwd').toString("utf8"));

  if(existsSync('./package.json')) {
    process.env.VERSION_FILE = './package.json'
  }
  // If composer.json is present, prefer it over package.json. API-Repository uses composer.json for versioning.
  if(existsSync('./composer.json')) {
    process.env.VERSION_FILE = './composer.json'
  }
  console.log(`Using ${process.env.VERSION_FILE}`);
}

// Run your GitHub Action!
Toolkit.run(async tools => {
  const pkg = JSON.parse(tools.getFile(process.env.VERSION_FILE))
  const event = tools.context.payload

  if (!event.commits) {
    console.log('Couldn\'t find any commits in this event, incrementing patch version...')
  }

  const messages = event.commits ? event.commits.map(commit => commit.message + '\n' + commit.body) : []

  const commitMessage = 'version bump to'
  console.log('messages:', messages);
  const isVersionBump = messages.map(message => message.toLowerCase().includes(commitMessage)).includes(true)
  if (isVersionBump) {
    tools.exit.success('No action necessary!')
    return
  }

  const majorWords = process.env['INPUT_MAJOR-WORDING'].split(',')
  const minorWords = process.env['INPUT_MINOR-WORDING'].split(',')
  const patchWords = process.env['INPUT_PATCH-WORDING'].split(',')
  const preReleaseWords = process.env['INPUT_RC-WORDING'].split(',')

  let version = process.env['INPUT_DEFAULT'] || 'patch'
  let foundWord = null;
  
  if (messages.some(
    message => /^([a-zA-Z]+)(\(.+\))?(\!)\:/.test(message) || majorWords.some(word => message.includes(word)))) {
    version = 'major'
  } else if (messages.some(message => minorWords.some(word => message.includes(word)))) {
    version = 'minor'
  } else if (messages.some(message => preReleaseWords.some(word => {
        if (message.includes(word)) {
          foundWord = word;
          return true;
        } else {
          return false;
        }
      }
    ))) {
      const preid = foundWord.split("-")[1];
      version = `prerelease --preid=${preid}`;
  } else if (patchWords && Array.isArray(patchWords) && patchWords.filter(p => p != '').length > 0) {
    if (!messages.some(message => patchWords.some(word => message.includes(word)))) {
      version = null
    }
  }

  if (version === null) {
    tools.exit.success('No version keywords found, skipping bump.')
    return
  }

  try {
    const current = pkg.version.toString()
    // set git user
    await tools.runInWorkspace('git',
      ['config', 'user.name', `"${process.env.GITHUB_USER || 'Automated Version Bump'}"`])
    await tools.runInWorkspace('git',
      ['config', 'user.email', `"${process.env.GITHUB_EMAIL || 'versionBot@edudip.com'}"`])

    let currentBranch = /refs\/[a-zA-Z]+\/(.*)/.exec(process.env.GITHUB_REF)[1]
    let isPullRequest = false
    if (process.env.GITHUB_HEAD_REF) {
      // Comes from a pull request
      currentBranch = process.env.GITHUB_HEAD_REF
      isPullRequest = true
    }
    console.log('currentBranch:', currentBranch)
    // do it in the current checked out github branch (DETACHED HEAD)
    // important for further usage of the package.json version
    console.log('current:', current, '/', 'version:', version)
    let newVersion = inc(current,version).toString().trim()
    pkg.version = newVersion
    writeFileSync(process.env.VERSION_FILE,JSON.stringify(pkg,null,2))
    await tools.runInWorkspace('git', ['commit', '-a', '-m', `ci: ${commitMessage} ${newVersion}`])

    // now go to the actual branch to perform the same versioning
    if (isPullRequest) {
      // First fetch to get updated local version of branch
      await tools.runInWorkspace('git', ['fetch'])
    }
    await tools.runInWorkspace('git', ['checkout', currentBranch])
    console.log('current:', current, '/', 'version:', version)
    newVersionWithPrefix = `${process.env['INPUT_TAG-PREFIX']}${newVersion}`
    console.log('new version:', newVersionWithPrefix)
    try {
      // to support "actions/checkout@v1"
      await tools.runInWorkspace('git', ['commit', '-a', '-m', `ci: ${commitMessage} ${newVersionWithPrefix}`])
    } catch (e) {
      console.warn('git commit failed because you are using "actions/checkout@v2"; ' +
        'but that doesnt matter because you dont need that git commit, thats only for "actions/checkout@v1"')
    }

    const remoteRepo = `https://${process.env.GITHUB_ACTOR}:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`
    if (process.env['INPUT_SKIP-TAG'] !== 'true') {
      await tools.runInWorkspace('git', ['tag', newVersionWithPrefix])
      await tools.runInWorkspace('git', ['push', remoteRepo, '--follow-tags'])
      await tools.runInWorkspace('git', ['push', remoteRepo, '--tags'])
    } else {
      await tools.runInWorkspace('git', ['push', remoteRepo])
    }
  } catch (e) {
    tools.log.fatal(e)
    tools.exit.failure('Failed to bump version')
  }
  tools.exit.success('Version bumped!')
})

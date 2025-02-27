const { DateTime } = require('luxon');

const { logger, setMeta } = require('../../logger');
const schedule = require('./schedule');
const { getUpdatedPackageFiles } = require('./get-updated');
const { getAdditionalFiles } = require('../../manager/npm/post-update');
const { commitFilesToBranch } = require('./commit');
const { getParentBranch } = require('./parent');
const { tryBranchAutomerge } = require('./automerge');
const { setUnpublishable } = require('./status-checks');
const { prAlreadyExisted } = require('./check-existing');
const prWorker = require('../pr');
const { appName, appSlug } = require('../../config/app-strings');

const { isScheduledNow } = schedule;

module.exports = {
  processBranch,
};

async function processBranch(branchConfig, prHourlyLimitReached, packageFiles) {
  const config = { ...branchConfig };
  const dependencies = config.upgrades
    .map(upgrade => upgrade.depName)
    .filter(v => v) // remove nulls (happens for lock file maintenance)
    .filter((value, i, list) => list.indexOf(value) === i); // remove duplicates
  setMeta({
    repository: config.repository,
    branch: config.branchName,
    dependencies,
  });
  logger.debug(`processBranch with ${branchConfig.upgrades.length} upgrades`);
  logger.trace({ config });
  await platform.setBaseBranch(config.baseBranch);
  const branchExists = await platform.branchExists(config.branchName);
  const branchPr = await platform.getBranchPr(config.branchName);
  logger.debug(`branchExists=${branchExists}`);
  const masterIssueCheck = (config.masterIssueChecks || {})[config.branchName];
  // istanbul ignore if
  if (masterIssueCheck) {
    logger.info('Branch has been checked in master issue: ' + masterIssueCheck);
  }
  if (branchPr) {
    config.rebaseRequested = rebaseCheck(config, branchPr);
    logger.debug(`Branch pr rebase requested: ${config.rebaseRequested}`);
  }
  try {
    logger.debug(`Branch has ${dependencies.length} upgrade(s)`);

    // Check if branch already existed
    const existingPr = branchPr ? undefined : await prAlreadyExisted(config);
    if (existingPr && !masterIssueCheck) {
      logger.debug(
        { prTitle: config.prTitle },
        'Closed PR already exists. Skipping branch.'
      );
      if (existingPr.state === 'closed') {
        const subject = `${appName} Ignore Notification`;
        let content;
        if (config.updateType === 'major') {
          content = `As this PR has been closed unmerged, ${appName} will ignore this upgrade and you will not receive PRs for *any* future ${config.newMajor}.x releases. However, if you upgrade to ${config.newMajor}.x manually then ${appName} will then reenable updates for minor and patch updates automatically.`;
        } else if (config.updateType === 'digest') {
          content = `As this PR has been closed unmerged, ${appName} will ignore this upgrade updateType and you will not receive PRs for *any* future ${config.depName}:${config.currentValue} digest updates. Digest updates will resume if you update the specified tag at any time.`;
        } else {
          content = `As this PR has been closed unmerged, ${appName} will now ignore this update (${config.newValue}). You will still receive a PR once a newer version is released, so if you wish to permanently ignore this dependency, please add it to the \`ignoreDeps\` array of your renovate config.`;
        }
        content +=
          '\n\nIf this PR was closed by mistake or you changed your mind, you can simply rename this PR and you will soon get a fresh replacement PR opened.';
        if (!config.suppressNotifications.includes('prIgnoreNotification')) {
          if (config.dryRun) {
            logger.info(
              'DRY-RUN: Would ensure closed PR comment in PR #' +
                existingPr.number
            );
          } else {
            await platform.ensureComment(existingPr.number, subject, content);
          }
        }
        if (branchExists) {
          if (config.dryRun) {
            logger.info('DRY-RUN: Would delete branch ' + config.branchName);
          } else {
            await platform.deleteBranch(config.branchName);
          }
        }
      } else if (existingPr.state === 'merged') {
        logger.info(
          { pr: existingPr.number },
          'Merged PR is blocking this branch'
        );
      }
      return 'already-existed';
    }
    // istanbul ignore if
    if (!branchExists && config.masterIssueApproval) {
      if (masterIssueCheck) {
        logger.info(`Branch ${config.branchName} is approved for creation`);
      } else {
        logger.info(`Branch ${config.branchName} needs approval`);
        return 'needs-approval';
      }
    }
    if (
      !branchExists &&
      prHourlyLimitReached &&
      !masterIssueCheck &&
      !config.vulnerabilityAlert
    ) {
      logger.info('Reached PR creation limit - skipping branch creation');
      return 'pr-hourly-limit-reached';
    }
    if (branchExists) {
      logger.debug('Checking if PR has been edited');
      if (branchPr) {
        logger.debug('Found existing branch PR');
        if (branchPr.state !== 'open') {
          logger.info(
            'PR has been closed or merged since this run started - aborting'
          );
          throw new Error('repository-changed');
        }
        if (!branchPr.canRebase) {
          const subject = 'PR has been edited';
          if (masterIssueCheck || config.rebaseRequested) {
            if (config.dryRun) {
              logger.info(
                'DRY-RUN: Would ensure PR edited comment removal in PR #' +
                  branchPr.number
              );
            } else {
              await platform.ensureCommentRemoval(branchPr.number, subject);
            }
          } else {
            let content = `:construction_worker: This PR has received other commits, so ${appName} will stop updating it to avoid conflicts or other problems.`;
            content += ` If you wish to abandon your changes and have ${appName} start over you may click the "rebase" checkbox in the PR body/description.`;
            if (!config.suppressNotifications.includes('prEditNotification')) {
              if (config.dryRun) {
                logger.info(
                  'DRY-RUN: ensure comment in PR #' + branchPr.number
                );
              } else {
                await platform.ensureComment(branchPr.number, subject, content);
              }
            }
            return 'pr-edited';
          }
        }
      }
    }

    // Check schedule
    config.isScheduledNow = isScheduledNow(config);
    if (!config.isScheduledNow && !masterIssueCheck) {
      if (!branchExists) {
        logger.info('Skipping branch creation as not within schedule');
        return 'not-scheduled';
      }
      if (config.updateNotScheduled === false && !config.rebaseRequested) {
        logger.debug('Skipping branch update as not within schedule');
        return 'not-scheduled';
      }
      // istanbul ignore if
      if (!branchPr) {
        logger.debug('Skipping PR creation out of schedule');
        return 'not-scheduled';
      }
      logger.debug(
        'Branch + PR exists but is not scheduled -- will update if necessary'
      );
    }

    if (
      config.updateType !== 'lockFileMaintenance' &&
      config.unpublishSafe &&
      config.canBeUnpublished &&
      (config.prCreation === 'not-pending' ||
        /* istanbul ignore next */ config.prCreation === 'status-success')
    ) {
      logger.info(
        'Skipping branch creation due to unpublishSafe + status checks'
      );
      return 'pending';
    }
    // istanbul ignore if
    if (masterIssueCheck === 'rebase' || config.masterIssueRebaseAllOpen) {
      logger.info('Manual rebase requested via master issue');
      delete config.parentBranch;
    } else {
      Object.assign(config, await getParentBranch(config));
    }
    logger.debug(`Using parentBranch: ${config.parentBranch}`);
    const res = await getUpdatedPackageFiles(config);
    // istanbul ignore if
    if (res.artifactErrors && config.artifactErrors) {
      res.artifactErrors = config.artifactErrors.concat(res.artifactErrors);
    }
    Object.assign(config, res);
    if (config.updatedPackageFiles && config.updatedPackageFiles.length) {
      logger.debug(
        `Updated ${config.updatedPackageFiles.length} package files`
      );
    } else {
      logger.debug('No package files need updating');
    }
    const additionalFiles = await getAdditionalFiles(config, packageFiles);
    config.artifactErrors = (config.artifactErrors || []).concat(
      additionalFiles.artifactErrors
    );
    config.updatedArtifacts = (config.updatedArtifacts || []).concat(
      additionalFiles.updatedArtifacts
    );
    if (config.updatedArtifacts && config.updatedArtifacts.length) {
      logger.debug(
        {
          updatedArtifacts: config.updatedArtifacts.map(f =>
            f.name === '|delete|' ? `${f.contents} (delete)` : f.name
          ),
        },
        `Updated ${config.updatedArtifacts.length} lock files`
      );
    } else {
      logger.debug('No updated lock files in branch');
    }
    if (config.artifactErrors && config.artifactErrors.length) {
      if (config.releaseTimestamp) {
        logger.debug(`Branch timestamp: ` + config.releaseTimestamp);
        const releaseTimestamp = DateTime.fromISO(config.releaseTimestamp);
        if (releaseTimestamp.plus({ days: 1 }) < DateTime.local()) {
          logger.info('PR is older than a day, raise PR with lock file errors');
        } else if (branchExists) {
          logger.info(
            'PR is less than a day old but branchExists so updating anyway'
          );
        } else {
          logger.info('PR is less than a day old - raise error instead of PR');
          throw new Error('lockfile-error');
        }
      } else {
        logger.debug('PR has no releaseTimestamp');
      }
    }

    config.committedFiles = await commitFilesToBranch(config);
    if (
      config.updateType === 'lockFileMaintenance' &&
      !config.committedFiles &&
      !config.parentBranch &&
      branchExists
    ) {
      logger.info(
        'Deleting lock file maintenance branch as master lock file no longer needs updating'
      );
      if (config.dryRun) {
        logger.info('DRY-RUN: Would delete lock file maintenance branch');
      } else {
        await platform.deleteBranch(config.branchName);
      }
      return 'done';
    }
    if (!(config.committedFiles || branchExists)) {
      return 'no-work';
    }

    // Set branch statuses
    await setUnpublishable(config);

    // Try to automerge branch and finish if successful, but only if branch already existed before this run
    if (branchExists || !config.requiresStatusChecks) {
      const mergeStatus = await tryBranchAutomerge(config);
      logger.debug(`mergeStatus=${mergeStatus}`);
      if (mergeStatus === 'automerged') {
        logger.debug('Branch is automerged - returning');
        return 'automerged';
      }
      if (
        mergeStatus === 'automerge aborted - PR exists' ||
        mergeStatus === 'branch status error' ||
        mergeStatus === 'failed'
      ) {
        logger.info({ mergeStatus }, 'Branch automerge not possible');
        config.forcePr = true;
        config.branchAutomergeFailureMessage = mergeStatus;
      }
    }
  } catch (err) /* istanbul ignore next */ {
    if (err.statusCode === 404) {
      throw new Error('repository-changed');
    }
    if (err.message === 'rate-limit-exceeded') {
      logger.debug('Passing rate-limit-exceeded error up');
      throw err;
    }
    if (err.message === 'repository-changed') {
      logger.debug('Passing repository-changed error up');
      throw err;
    }
    if (
      err.message &&
      err.message.startsWith('remote: Invalid username or password')
    ) {
      logger.debug('Throwing bad credentials');
      throw new Error('bad-credentials');
    }
    if (
      err.message &&
      err.message.startsWith(
        'ssh_exchange_identification: Connection closed by remote host'
      )
    ) {
      logger.debug('Throwing bad credentials');
      throw new Error('bad-credentials');
    }
    if (err.message === 'bad-credentials') {
      logger.debug('Passing bad-credentials error up');
      throw err;
    }
    if (err.message === 'integration-unauthorized') {
      logger.debug('Passing integration-unauthorized error up');
      throw err;
    }
    if (err.message === 'lockfile-error') {
      logger.debug('Passing lockfile-error up');
      throw err;
    }
    if (err.message && err.message.includes('space left on device')) {
      throw new Error('disk-space');
    }
    if (err.message.startsWith('disk-space')) {
      logger.debug('Passing disk-space error up');
      throw err;
    }
    if (err.message.startsWith('Resource not accessible by integration')) {
      logger.debug('Passing 403 error up');
      throw err;
    }
    if (err.message === 'update-failure') {
      logger.warn('Error updating branch: update failure');
    } else if (
      err.message === 'bundler-fs' ||
      err.message === 'bundler-credentials' ||
      err.message === 'bundler-unknown'
    ) {
      // we have already warned, so just return
      return 'error';
    } else if (
      err.messagee &&
      err.message.includes('fatal: Authentication failed')
    ) {
      throw new Error('authentication-failure');
    } else if (
      err.message !== 'registry-failure' &&
      err.message !== 'disable-gitfs' &&
      err.message !== 'platform-failure'
    ) {
      logger.error({ err }, `Error updating branch: ${err.message}`);
    }
    // Don't throw here - we don't want to stop the other renovations
    return 'error';
  }
  try {
    logger.debug('Ensuring PR');
    logger.debug(
      `There are ${config.errors.length} errors and ${config.warnings.length} warnings`
    );
    const pr = await prWorker.ensurePr(config);
    // TODO: ensurePr should check for automerge itself
    if (pr === 'needs-pr-approval') {
      return 'needs-pr-approval';
    }
    if (pr) {
      const topic = ':warning: Artifact update problem';
      if (config.artifactErrors && config.artifactErrors.length) {
        logger.warn(
          { artifactErrors: config.artifactErrors },
          'artifactErrors'
        );
        let content = `${appName} failed to update `;
        content +=
          config.artifactErrors.length > 1 ? 'artifacts' : 'an artifact';
        content +=
          ' related to this branch. You probably do not want to merge this PR as-is.';
        content += `\n\n:recycle: ${appName} will retry this branch, including artifacts, only when one of the following happens:\n\n`;
        content +=
          ' - any of the package files in this branch needs updating, or \n';
        content += ' - the branch becomes conflicted, or\n';
        content +=
          ' - you check the rebase/retry checkbox if found above, or\n';
        content +=
          ' - you rename this PR\'s title to start with "rebase!" to trigger it manually';
        content += '\n\nThe artifact failure details are included below:\n\n';
        config.artifactErrors.forEach(error => {
          content += `##### File name: ${error.lockFile}\n\n`;
          content += `\`\`\`\n${error.stderr}\n\`\`\`\n\n`;
        });
        if (
          !(
            config.suppressNotifications.includes('artifactErrors') ||
            config.suppressNotifications.includes('lockFileErrors')
          )
        ) {
          if (config.dryRun) {
            logger.info(
              'DRY-RUN: Would ensure lock file error comment in PR #' +
                pr.number
            );
          } else {
            await platform.ensureComment(pr.number, topic, content);
            // TODO: remoe this soon once they're all cleared out
            await platform.ensureCommentRemoval(
              pr.number,
              ':warning: Lock file problem'
            );
          }
        }
        const context = `${appSlug}/artifacts`;
        const description = 'Artifact file update failure';
        const state = 'failure';
        const existingState = await platform.getBranchStatusCheck(
          config.branchName,
          context
        );
        // Check if state needs setting
        if (existingState !== state) {
          logger.debug(`Updating status check state to failed`);
          if (config.dryRun) {
            logger.info(
              'DRY-RUN: Would set branch status in ' + config.branchName
            );
          } else {
            await platform.setBranchStatus(
              config.branchName,
              context,
              description,
              state
            );
          }
        }
      } else {
        if (config.updatedArtifacts && config.updatedArtifacts.length) {
          // istanbul ignore if
          if (config.dryRun) {
            logger.info(
              'DRY-RUN: Would ensure comment removal in PR #' + pr.number
            );
          } else {
            await platform.ensureCommentRemoval(pr.number, topic);
          }
        }
        const prAutomerged = await prWorker.checkAutoMerge(pr, config);
        if (prAutomerged) {
          return 'automerged';
        }
      }
    }
  } catch (err) /* istanbul ignore next */ {
    if (
      [
        'rate-limit-exceeded',
        'platform-failure',
        'repository-changed',
      ].includes(err.message)
    ) {
      logger.debug('Passing PR error up');
      throw err;
    }
    // Otherwise don't throw here - we don't want to stop the other renovations
    logger.error({ err }, `Error ensuring PR: ${err.message}`);
  }
  if (!branchExists) {
    return 'pr-created';
  }
  return 'done';
}

function rebaseCheck(config, branchPr) {
  const titleRebase = branchPr.title && branchPr.title.startsWith('rebase!');
  const labelRebase =
    branchPr.labels && branchPr.labels.includes(config.rebaseLabel);
  const prRebaseChecked =
    branchPr.body && branchPr.body.includes(`- [x] <!-- ${appSlug}-rebase -->`);

  return titleRebase || labelRebase || prRebaseChecked;
}

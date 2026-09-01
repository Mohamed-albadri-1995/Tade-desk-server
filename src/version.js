/*
 * Which code is this process actually running?
 *
 * WHY THIS EXISTS. A deploy finished, every health check passed, and the page
 * in the browser was still the old one — with no way to tell from the page
 * whether the new code had arrived, whether the browser was showing a cached
 * copy, or whether the change had simply not worked. Three very different
 * problems that look identical, and no way to separate them without an SSH
 * session.
 *
 * So the running commit is now a fact the page can show. "It says 4fa1f05" is
 * a complete answer to "did the deploy reach you", and it takes one glance.
 *
 * Read ONCE at startup, on purpose: it must describe the code this process
 * loaded, not the code sitting in the working tree. Those differ for exactly
 * as long as a process has not been restarted, which is precisely the window
 * where the question gets asked.
 */

const { execSync } = require('child_process');
const path = require('path');

function readGit() {
  const cwd = path.join(__dirname, '..');
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    let subject = '';
    try {
      subject = execSync('git log -1 --format=%s', {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().slice(0, 120);
    } catch { /* a shallow clone still has a SHA */ }
    return { sha, subject };
  } catch {
    // Not a git checkout, or git is not installed. Not an error: the tool runs
    // fine, it just cannot say which commit it is.
    return { sha: null, subject: '' };
  }
}

const GIT = readGit();
const STARTED_AT = Date.now();

function version() {
  return {
    sha: GIT.sha,
    subject: GIT.subject,
    startedAt: STARTED_AT,
    // The page compares this against its OWN copy of the sha. If they differ,
    // the browser is showing a cached page and says so — which is the failure
    // this whole file was written for.
    node: process.version,
  };
}

module.exports = { version, SHA: GIT.sha, STARTED_AT };

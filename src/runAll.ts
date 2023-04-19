export { runAll }

import type { Browser } from 'playwright-chromium'
import { getCurrentTest, type TestInfo } from './getCurrentTest'
import { Logs } from './Logs'
import { assert, assertUsage, humanizeTime, isCI, isTTY, isWindows, logProgress } from './utils'
import { type FindFilter, fsWindowsBugWorkaround } from './utils'
import { isParallelCI } from './parallel-ci'
import { setCurrentTest } from './getCurrentTest'
import { getBrowser } from './getBrowser'
import { buildTs } from './buildTs'
import { findTestFiles } from './findTestFiles'
import { loadConfig } from './getConfig'
import { logError } from './logError'
import { hasFail, logFail, logPass, logWarn } from './logTestStatus'

async function runAll(filter: null | FindFilter) {
  await loadConfig()

  const testFiles = await findTestFiles(filter)

  const browser = await getBrowser()

  const failedTestFiles = await runTestFiles(testFiles, browser)

  await browser.close()

  const hasFailedTestFile = failedTestFiles.length > 0
  const hasFailLog = hasFail()
  if (hasFailedTestFile || hasFailLog) {
    // hasFailedTestFile and hasFailLog are redundant
    //  - When assert.ts calls logFail() this code block isn't run
    assert(hasFailedTestFile && hasFailLog)
    assert(failedTestFiles.length > 0)
    throw new Error(
      [
        'Following test files failed, see all the logs printed above for more information.',
        ...failedTestFiles.map((testFile) => `  ${testFile}`),
      ].join('\n')
    )
  }
}

async function runTestFiles(testFiles: string[], browser: Browser): Promise<string[]> {
  const failedFirstAttempt: string[] = []
  for (const testFile of testFiles) {
    const success = await buildAndTest(testFile, browser, false)
    if (!success) {
      failedFirstAttempt.push(testFile)
    }
  }
  if (!isCI()) {
    return failedFirstAttempt
  }

  const failedSecondAttempt: string[] = []
  for (const testFile of failedFirstAttempt) {
    const success = await buildAndTest(testFile, browser, true)
    if (!success) {
      failedSecondAttempt.push(testFile)
    }
  }

  return failedSecondAttempt
}

async function buildAndTest(testFile: string, browser: Browser, isSecondAttempt: boolean): Promise<boolean> {
  assert(testFile.endsWith('.ts'))
  const testFileJs = testFile.replace('.ts', '.mjs')
  assert(testFileJs.endsWith('.mjs'))
  const cleanBuild = await buildTs(testFile, testFileJs)
  setCurrentTest(testFile)
  try {
    await import(fsWindowsBugWorkaround(testFileJs) + `?cacheBuster=${Date.now()}`)
  } finally {
    cleanBuild()
  }
  const success = await runServerAndTests(browser, isSecondAttempt)
  setCurrentTest(null)
  return success
}

async function runServerAndTests(browser: Browser, isSecondAttempt: boolean): Promise<boolean> {
  const testInfo = getCurrentTest()

  // Set when user calls `skip()`
  if (testInfo.skipped) {
    assertSkipUsage(testInfo)
    logWarn(testInfo.skipped.reason)
    return true
  }

  // Set when user calls `run()`
  assert(testInfo.runInfo)
  assert(testInfo.startServer)
  assert(testInfo.terminateServer)

  const isFinalAttempt: boolean = isSecondAttempt || !testInfo.runInfo.isFlaky

  const abortMaybe = () => {
    if (isFinalAttempt && isParallelCI()) {
      process.exit(1)
    }
  }

  const page = await browser.newPage()
  testInfo.page = page

  try {
    await testInfo.startServer()
  } catch (err) {
    logFailure(err, 'an error occurred while starting the server', isFinalAttempt)
    abortMaybe()
    return false
  }

  let success = await runTests(testInfo, isFinalAttempt)

  await testInfo.terminateServer()
  await page.close()
  // Check whether stderr emitted during testInfo.terminateServer()
  if (success) {
    const failOnWarning = true
    if (
      Logs.hasFailLogs(failOnWarning) &&
      // See comments about taskkill in src/setup.ts
      !isWindows()
    ) {
      logFailure(null, `${getErrorType(failOnWarning)} occurred during server termination`, isFinalAttempt)
      success = false
    }
  }

  if (success) {
    logPass()
  } else {
    abortMaybe()
  }
  Logs.clearLogs()

  return success
}

async function runTests(testInfo: TestInfo, isFinalAttempt: boolean): Promise<boolean> {
  // Set when user calls `run()`
  assert(testInfo.runInfo)
  assert(testInfo.afterEach)
  // Set when user calls `test()`
  assert(testInfo.tests)
  for (const { testDesc, testFn } of testInfo.tests) {
    Logs.add({
      logSource: 'test()',
      logText: testDesc,
    })
    const done = logProgress(`[test] ${testDesc}`)
    let err: unknown
    try {
      await runTest(testFn, testInfo.runInfo.testFunctionTimeout)
    } catch (err_) {
      err = err_
    }
    done(!!err)
    testInfo.afterEach(!!err)
    {
      const failOnWarning = !testInfo.runInfo.doNotFailOnWarning
      const hasErrorLog = Logs.hasFailLogs(failOnWarning)
      const isFailure = err || hasErrorLog
      if (isFailure) {
        if (err) {
          logFailure(err, `the test "${testDesc}" threw an error`, isFinalAttempt)
        } else if (hasErrorLog) {
          logFailure(
            null,
            `${getErrorType(failOnWarning)} occurred while running the test "${testDesc}"`,
            isFinalAttempt
          )
        } else {
          assert(false)
        }
        return false
      }
    }
    Logs.clearLogs()
  }

  return true
}

function logFailure(err: null | unknown, reason: string, isFinalAttempt: boolean) {
  logFail(reason, isFinalAttempt)
  if (err) {
    logError(err)
  }
  Logs.logErrorsAndWarnings()
  Logs.flushLogs()
}

function getErrorType(failOnWarning: boolean) {
  return !failOnWarning ? 'error(s)' : 'error(s)/warning(s)'
}

function runTest(testFn: Function, testFunctionTimeout: number): Promise<undefined | unknown> {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((resolve_, reject_) => {
    resolve = resolve_
    reject = reject_
  })

  const timeout = setTimeout(() => {
    reject(new Error(`[test] Timeout after ${humanizeTime(testFunctionTimeout)}`))
  }, testFunctionTimeout)

  const ret: unknown = testFn()
  ;(async () => {
    try {
      await ret
      resolve()
    } catch (err) {
      reject(err)
    } finally {
      clearTimeout(timeout)
    }
  })()

  return promise
}

function assertSkipUsage(testInfo: TestInfo) {
  assert(testInfo.skipped)
  {
    const err = 'You cannot call run() after calling skip()'
    assertUsage(testInfo.runInfo === undefined, err)
  }
  {
    const err = 'You cannot call test() after calling skip()'
    assertUsage(testInfo.tests === undefined, err)
  }
}

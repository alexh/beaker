import test from 'ava'
import {Application} from 'spectron'
import os from 'os'
import path from 'path'
import fs from 'fs'
import electron from '../node_modules/electron'

import * as browserdriver from './lib/browser-driver'
import { shareDat } from './lib/dat-helpers'

const app = new Application({
  path: electron,
  args: ['../app'],
  chromeDriverLogPath: 'dat-web-api-test.log',
  env: { 
    beaker_user_data_path: fs.mkdtempSync(os.tmpdir() + path.sep + 'beaker-test-'),
    beaker_dat_quota_default_bytes_allowed: 1024 // 1kb
  }
})
var testStaticDat, testStaticDatURL
var testRunnerDat, testRunnerDatURL
var createdDatURL // url of the dat which is created by testRunnerDat, which gives it write access
var createdDatKey

test.before(async t => {
  // open the window
  await app.start()
  await app.client.waitUntilWindowLoaded()

  // share the test static dat
  testStaticDat = await shareDat(__dirname + '/scaffold/test-static-dat')
  testStaticDatURL = 'dat://' + testStaticDat.archive.key.toString('hex') + '/'

  // share the test runner dat
  testRunnerDat = await shareDat(__dirname + '/scaffold/test-runner-dat')
  testRunnerDatURL = 'dat://' + testRunnerDat.archive.key.toString('hex') + '/'

  // open the test-runner dat
  await browserdriver.navigateTo(app, testRunnerDatURL)
  await app.client.windowByIndex(1)
  await app.client.waitForExist('h1#loaded')
})
test.after.always('cleanup', async t => {
  console.log(await app.client.getMainProcessLogs())
  await app.stop()
})

// some custom wrappers around async calls
// (the remove execution can be a little janky, these wrappers solve that)
async function stat (url, opts) {
  var res = await app.client.executeAsync((url, opts, done) => {
    dat.stat(url, opts).then(v => done(stringify(v)), done)
  }, url, opts)
  if (typeof res.value === 'string')
    res.value = JSON.parse(res.value)
  return res
}

// tests
//

test('dat.readDirectory', async t => {
  async function readDirectory (url, opts) {
    return app.client.executeAsync((url, opts, done) => {
      dat.readDirectory(url, opts).then(done, done)
    }, url, opts || null)
  }

  // root dir
  let listing1 = await readDirectory(testStaticDatURL)
  t.deepEqual(Object.keys(listing1.value).sort(), ['beaker.png', 'hello.txt', 'subdir'])

  // subdir
  let listing2 = await readDirectory(testStaticDatURL + 'subdir')
  t.deepEqual(Object.keys(listing2.value).sort(), ['hello.txt'])
})

test('dat.readFile', async t => {
  async function readFile (url, opts) {
    return app.client.executeAsync((url, opts, done) => {
      dat.readFile(url, opts).then(done, done)
    }, url, opts)
  }

  var beakerPng = fs.readFileSync(__dirname + '/scaffold/test-static-dat/beaker.png')

  // read utf8
  var helloTxt = await readFile(testStaticDatURL + 'hello.txt', {})
  t.deepEqual(helloTxt.value, 'hello')

  // read utf8 2
  var helloTxt2 = await readFile(testStaticDatURL + 'subdir/hello.txt', 'utf8')
  t.deepEqual(helloTxt2.value, 'hi')

  // read hex
  var beakerPngHex = await readFile(testStaticDatURL + 'beaker.png', 'hex')
  t.deepEqual(beakerPngHex.value, beakerPng.toString('hex'))

  // read base64
  var beakerPngBase64 = await readFile(testStaticDatURL + 'beaker.png', 'base64')
  t.deepEqual(beakerPngBase64.value, beakerPng.toString('base64'))

  // read binary
  var beakerPngBinary = await readFile(testStaticDatURL + 'beaker.png', 'binary')
  t.ok(beakerPng.equals(Buffer.from(beakerPngBinary.value)))
})

test('dat.stat', async t => {
  // stat root file
  var entry = await stat(testStaticDatURL + 'hello.txt', {})
  t.deepEqual(entry.value.name, 'hello.txt')
  t.deepEqual(entry.value.type, 'file')

  // stat subdir file
  var entry = await stat(testStaticDatURL + 'subdir/hello.txt', {})
  t.deepEqual(entry.value.name, 'subdir/hello.txt')
  t.deepEqual(entry.value.type, 'file')

  // stat subdir
  var entry = await stat(testStaticDatURL + 'subdir', {})
  t.deepEqual(entry.value.name, 'subdir')
  t.deepEqual(entry.value.type, 'directory')

  // stat non-existent file
  var entry = await stat(testStaticDatURL + 'notfound', {})
  t.deepEqual(entry.value.name, 'FileNotFoundError')

  // stat acceptably-malformed path
  var entry = await stat(testStaticDatURL + '/hello.txt', {})
  t.deepEqual(entry.value.name, 'hello.txt')
  t.deepEqual(entry.value.type, 'file')
})

test('dat.createArchive rejection', async t => {
  // start the prompt
  await app.client.execute(() => {
    // put the result on the window, for checking later
    window.res = null
    dat.createArchive({ title: 'The Title', description: 'The Description' }).then(
      res => window.res = res,
      err => window.res = err
    )
  })

  // reject the prompt
  await app.client.windowByIndex(0)
  await app.client.click('.prompt-reject')
  await app.client.windowByIndex(1)

  // fetch & test the res
  var res = await app.client.execute(() => { return window.res })
  t.deepEqual(res.value.name, 'UserDeniedError')
})

test('dat.createArchive', async t => {
  // start the prompt
  await app.client.execute(() => {
    // put the result on the window, for checking later
    window.res = null
    dat.createArchive({ title: 'The Title', description: 'The Description' }).then(
      res => window.res = res,
      err => window.res = err
    )
  })

  // accept the prompt
  await app.client.windowByIndex(0)
  await app.client.click('.prompt-accept')
  await app.client.windowByIndex(1)

  // fetch & test the res
  var res = await app.client.execute(() => { return window.res })
  createdDatURL = res.value
  t.truthy(createdDatURL.startsWith('dat://'))
  createdDatKey = createdDatURL.slice('dat://'.length, -1)

  // check the dat.json
  var res = await app.client.executeAsync((url, done) => {
    dat.readFile(url).then(done, done)
  }, createdDatURL + 'dat.json')
  var manifest
  try {
    var manifest = JSON.parse(res.value)
  } catch (e) {
    console.log('unexpected error parsing manifest', res.value)
  }
  t.deepEqual(manifest.title, 'The Title')
  t.deepEqual(manifest.description, 'The Description')
})

test('dat.writeFile', async t => {
  // write to the top-level
  var res = await app.client.executeAsync((url, done) => {
    dat.writeFile(url, 'hello world', 'utf8').then(done, done)
  }, createdDatURL + 'hello.txt')
  t.falsy(res.value)

  // read it back
  var res = await app.client.executeAsync((url, opts, done) => {
    dat.readFile(url, opts).then(done, done)
  }, createdDatURL + 'hello.txt', 'utf8')
  t.deepEqual(res.value, 'hello world')
})

test('dat.writeFile does not write to nonexistent directories', async t => {
  // write to a subdir
  var res = await app.client.executeAsync((url, done) => {
    dat.writeFile(url, 'hello world', 'utf8').then(done, done)
  }, createdDatURL + 'subdir/hello.txt')
  t.deepEqual(res.value.name, 'ParentFolderDoesntExistError')
})

test('dat.writeFile protects the root and manifest', async t => {
  // write to the top-level folder
  var res = await app.client.executeAsync((url, done) => {
    dat.writeFile(url, 'hello world', 'utf8').then(done, done)
  }, createdDatURL)
  t.deepEqual(res.value.name, 'ProtectedFileNotWritableError')

  // write to the manifest
  var res = await app.client.executeAsync((url, done) => {
    dat.writeFile(url, 'hello world', 'utf8').then(done, done)
  }, createdDatURL + 'dat.json')
  t.deepEqual(res.value.name, 'ProtectedFileNotWritableError')
})

test('dat.createDirectory', async t => {
  // create the directory
  var res = await app.client.executeAsync((url, done) => {
    dat.createDirectory(url).then(done, done)
  }, createdDatURL + 'subdir')
  t.falsy(res.value)

  // read it back
  var res = await stat(createdDatURL + 'subdir')
  t.deepEqual(res.value.type, 'directory')
})

test('dat.writeFile writes to subdirectories', async t => {
  // write to a subdir
  var res = await app.client.executeAsync((url, done) => {
    dat.writeFile(url, 'hello world', 'utf8').then(done, done)
  }, createdDatURL + 'subdir/hello.txt')
  t.falsy(res.value)

  // read it back
  var res = await app.client.executeAsync((url, opts, done) => {
    dat.readFile(url, opts).then(done, done)
  }, createdDatURL + 'subdir/hello.txt', 'utf8')
  t.deepEqual(res.value, 'hello world')
})

test('dat.writeFile doesnt overwrite folders', async t => {
  // write to the subdir
  var res = await app.client.executeAsync((url, done) => {
    dat.writeFile(url, 'hello world', 'utf8').then(done, done)
  }, createdDatURL + '/subdir')
  t.deepEqual(res.value.name, 'FolderAlreadyExistsError')
})

test('dat.createDirectory doesnt overwrite files or folders', async t => {
  // write to the subdir
  var res = await app.client.executeAsync((url, done) => {
    dat.createDirectory(url).then(done, done)
  }, createdDatURL + '/subdir')
  t.deepEqual(res.value.name, 'FolderAlreadyExistsError')

  // write to the file
  var res = await app.client.executeAsync((url, done) => {
    dat.createDirectory(url).then(done, done)
  }, createdDatURL + '/hello.txt')
  t.deepEqual(res.value.name, 'FileAlreadyExistsError')
})

test('dat.writeFile doesnt allow writes to archives without a save claim', async t => {
  // write to the subdir
  var res = await app.client.executeAsync((url, done) => {
    dat.writeFile(url, 'hello world', 'utf8').then(done, done)
  }, testStaticDatURL + '/denythis.txt')
  t.deepEqual(res.value.name, 'PermissionsError')
})

test('dat.writeFile doesnt allow writes that exceed the quota', async t => {
  // write to the subdir
  var res = await app.client.executeAsync((url, done) => {
    dat.writeFile(url, 'x'.repeat(2048), 'utf8').then(done, done)
  }, createdDatURL + '/denythis.txt')
  t.deepEqual(res.value.name, 'QuotaExceededError')
})

test('dat.createDirectory doesnt allow writes to archives without a save claim', async t => {
  // write to the subdir
  var res = await app.client.executeAsync((url, done) => {
    dat.createDirectory(url).then(done, done)
  }, testStaticDatURL + '/denythis')
  t.deepEqual(res.value.name, 'PermissionsError')
})

test('dat.deleteArchive removes save claims', async t => {
  // check that the save-claim exists
  await app.client.windowByIndex(0)
  var details = await app.client.executeAsync((key, done) => {
    datInternalAPI.getArchiveDetails(key).then(done, err => done({ err }))
  }, createdDatKey)
  await app.client.windowByIndex(1)
  t.deepEqual(details.value.userSettings.saveClaims, [testRunnerDatURL.slice(0, -1)])

  // delete the archive
  var res = await app.client.executeAsync((url, done) => {
    dat.deleteArchive(url).then(done, err => done({ err }))
  }, createdDatURL)
  t.falsy(res.value)

  // check that the save-claim was removed
  await app.client.windowByIndex(0)
  var details = await app.client.executeAsync((key, done) => {
    datInternalAPI.getArchiveDetails(key).then(done, err => done({ err }))
  }, createdDatKey)
  await app.client.windowByIndex(1)
  t.deepEqual(details.value.userSettings.saveClaims.length, 0)

  // undo the deletion
  await app.client.windowByIndex(0)
  await app.client.click('.prompt-reject')
  await app.client.windowByIndex(1)

  // check that the new save-claim was added
  await app.client.windowByIndex(0)
  var details = await app.client.executeAsync((key, done) => {
    datInternalAPI.getArchiveDetails(key).then(done, err => done({ err }))
  }, createdDatKey)
  await app.client.windowByIndex(1)
  t.deepEqual(details.value.userSettings.saveClaims, ['beaker:archives'])
})

test('dat.serve and dat.unserve update the upload claims', async t => {
  // check that the upload-claim doesnt exist
  await app.client.windowByIndex(0)
  var details = await app.client.executeAsync((key, done) => {
    datInternalAPI.getArchiveDetails(key).then(done, err => done({ err }))
  }, createdDatKey)
  await app.client.windowByIndex(1)
  t.deepEqual(details.value.userSettings.uploadClaims, [])

  // serve the archive
  var res = await app.client.executeAsync((url, done) => {
    dat.serve(url).then(done, err => done({ err }))
  }, createdDatURL)
  t.falsy(res.value)

  // check that the upload-claim was added
  await app.client.windowByIndex(0)
  var details = await app.client.executeAsync((key, done) => {
    datInternalAPI.getArchiveDetails(key).then(done, err => done({ err }))
  }, createdDatKey)
  await app.client.windowByIndex(1)
  t.deepEqual(details.value.userSettings.uploadClaims, [testRunnerDatURL.slice(0, -1)])

  // unserve the archive
  var res = await app.client.executeAsync((url, done) => {
    dat.unserve(url).then(done, err => done({ err }))
  }, createdDatURL)
  t.falsy(res.value)

  // check that the upload-claim was removed
  await app.client.windowByIndex(0)
  var details = await app.client.executeAsync((key, done) => {
    datInternalAPI.getArchiveDetails(key).then(done, err => done({ err }))
  }, createdDatKey)
  await app.client.windowByIndex(1)
  t.deepEqual(details.value.userSettings.uploadClaims, [])
})
/* eslint-env mocha */
process.env.DEBUG = '*'
const { Server, Client } = require('node-nethernet')

// Check if running in CI environment
const isCI = process.env.CI || process.env.GITHUB_ACTIONS || process.env.TRAVIS || process.env.CIRCLECI

function createTestClient (networkId, additionalOptions = {}) {
  const options = {
    serverAddress: '127.0.0.1',
    ...additionalOptions
  }
  return new Client(networkId, options)
}

async function pingTest () {
  return new Promise((resolve, reject) => {
    const timeoutMs = isCI ? 20000 : 10000
    const timeout = setTimeout(() => {
      client.close()
      server.close()
      reject(new Error(`Ping test timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    if (isCI) console.log('Running ping test in CI environment with extended timeout')

    const message = 'FMCPE;JSRakNet - JS powered RakNet;408;1.16.20;0;5;0;JSRakNet;Creative;'
    const server = new Server()
    server.setAdvertisement(Buffer.from(message))
    const client = createTestClient(server.networkId)

    client.once('pong', (packet) => {
      clearTimeout(timeout)
      console.log('PONG data', packet)
      const msg = packet.data?.toString()
      if (!msg || msg !== message) {
        client.close()
        server.close()
        reject(new Error(`PONG mismatch ${msg} != ${message}`))
        return
      }
      console.log('OK')
      client.close()
      server.close()
      setTimeout(() => {
        resolve() // allow for server + client to close
      }, 500)
    })

    client.once('error', (err) => {
      clearTimeout(timeout)
      client.close()
      server.close()
      reject(err)
    })

    server.listen().catch(err => {
      clearTimeout(timeout)
      client.close()
      server.close()
      reject(err)
    })
    client.ping()
  })
}

async function connectTest () {
  return new Promise((resolve, reject) => {
    const timeoutMs = isCI ? 30000 : 15000
    const timeout = setTimeout(() => {
      client.close()
      server.close()
      reject(new Error(`Connect test timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    if (isCI) console.log('Running connect test in CI environment with extended timeout')

    const message = 'FMCPE;JSRakNet - JS powered RakNet;408;1.16.20;0;5;0;JSRakNet;Creative;'
    const server = new Server()
    server.setAdvertisement(Buffer.from(message))
    const client = createTestClient(server.networkId)

    server.listen().catch(err => {
      clearTimeout(timeout)
      client.close()
      server.close()
      reject(err)
    })
    
    let lastC = 0
    client.on('connected', () => {
      console.log('connected!')
      client.on('encapsulated', (encap) => {
        console.assert(encap[0] === 0xf0)
        const ix = encap[1]
        if (lastC++ !== ix) {
          clearTimeout(timeout)
          client.close()
          server.close()
          reject(new Error(`Packet mismatch: ${lastC - 1} != ${ix}`))
          return
        }
        client.send(encap)
      })
    })
    
    let lastS = 0
    server.on('encapsulated', (encap) => {
      console.assert(encap[0] === 0xf0)
      const ix = encap[1]
      if (lastS++ !== ix) {
        clearTimeout(timeout)
        client.close()
        server.close()
        reject(new Error(`Packet mismatch: ${lastS - 1} != ${ix}`))
        return
      }
      if (lastS === 50) {
        clearTimeout(timeout)
        client.close()
        server.close()
        resolve(true)
      }
    })
    
    server.on('openConnection', (client) => {
      console.debug('Client opened connection')
      for (let i = 0; i < 50; i++) {
        const buf = Buffer.alloc(1000)
        for (let j = 0; j < 64; j += 4) buf[j] = j + i
        buf[0] = 0xf0
        buf[1] = i
        client.send(buf)
      }
    })

    client.on('error', (err) => {
      clearTimeout(timeout)
      client.close()
      server.close()
      reject(err)
    })

    server.on('error', (err) => {
      clearTimeout(timeout)
      client.close()
      server.close()
      reject(err)
    })
    
    client.connect().catch(err => {
      clearTimeout(timeout)
      client.close()
      server.close()
      reject(err)
    })
  })
}

async function kickTest () {
  return new Promise((resolve, reject) => {
    const timeoutMs = isCI ? 20000 : 10000
    const timeout = setTimeout(() => {
      client.close()
      server.close()
      reject(new Error(`Kick test timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    if (isCI) console.log('Running kick test in CI environment with extended timeout')

    const server = new Server()
    server.setAdvertisement(Buffer.from([0]))
    const client = createTestClient(server.networkId)

    server.on('openConnection', (con) => {
      console.log('new connection')
      con.close()
    })
    
    server.listen().catch(err => {
      clearTimeout(timeout)
      client.close()
      server.close()
      reject(err)
    })
    
    client.on('disconnect', packet => {
      console.log('Client got disconnect', packet)
      try {
        client.send(Buffer.from('\xf0 yello'))
      } catch (e) {
        console.log('** Expected error 😀 **', e)
        clearTimeout(timeout)
        server.close()
        client.close()
        resolve()
      }
    })

    client.on('error', (err) => {
      clearTimeout(timeout)
      client.close()
      server.close()
      reject(err)
    })

    server.on('error', (err) => {
      clearTimeout(timeout)
      client.close()
      server.close()
      reject(err)
    })

    client.connect().catch(err => {
      clearTimeout(timeout)
      client.close()
      server.close()
      reject(err)
    })
  })
}

describe('server tests', function () {
  // Increase timeout for CI environments
  const testTimeout = isCI ? 60000 : 30000
  this.timeout(testTimeout)
  it('ping test', pingTest)
  it('connection test', connectTest)
  it('kick test', kickTest)
})

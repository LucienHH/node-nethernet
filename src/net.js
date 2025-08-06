const os = require('node:os')

function getBroadcastAddress () {
  const interfaces = os.networkInterfaces()

  for (const interfaceName in interfaces) {
    for (const iface of interfaces[interfaceName]) {
      // Only consider IPv4, non-internal (non-loopback) addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        const ip = iface.address.split('.').map(Number)
        const netmask = iface.netmask.split('.').map(Number)
        const broadcast = ip.map((octet, i) => (octet | (~netmask[i] & 255)))

        return broadcast.join('.') // Return the broadcast address
      }
    }
  }

  // Fallback to localhost for CI environments or when no suitable interface is found
  return '127.0.0.1'
}

module.exports = {
  getBroadcastAddress
}

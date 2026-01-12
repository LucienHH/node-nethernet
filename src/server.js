const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = require('@roamhq/wrtc')

const { Connection } = require('./connection')
const { SignalStructure, SignalType } = require('./signalling')

const { PACKET_TYPE, createSerializer, createDeserializer } = require('./serializer')

const { getRandomUint64, createPacketData, prepareSecurePacket, processSecurePacket } = require('./util')

const debug = require('debug')('nethernet')

class Server extends EventEmitter {
  constructor (options = {}) {
    super()

    this.options = options

    this.networkId = options.networkId ?? getRandomUint64()

    this.connections = new Map()

    this.serializer = createSerializer()
    this.deserializer = createDeserializer()
  }

  async handleCandidate (signal) {
    const conn = this.connections.get(signal.connectionId)

    if (conn) {
      try {
        const candidate = new RTCIceCandidate({ candidate: signal.data, sdpMid: '0', sdpMLineIndex: 0 })
        await conn.rtcConnection.addIceCandidate(candidate)
        debug('Added remote ICE candidate')
      } catch (err) {
        debug('Failed to add remote candidate:', err)
      }
    } else {
      debug('Connection not found', signal.connectionId)
    }
  }

  async handleOffer (signal, respond, credentials = []) {
    const rtcConnection = new RTCPeerConnection({ iceServers: credentials })

    const connection = new Connection(this, signal.connectionId, rtcConnection)

    this.connections.set(signal.connectionId, connection)

    debug('Received offer', signal.connectionId)

    rtcConnection.onicecandidate = (event) => {
      if (event.candidate) {
        debug('Sending ICE candidate to client')
        const signalStruct = new SignalStructure(SignalType.CandidateAdd, signal.connectionId, event.candidate.candidate, signal.networkId)

        respond(signalStruct)
      }
    }

    rtcConnection.ondatachannel = (event) => {
      const channel = event.channel
      debug('Received data channel', channel.label)

      channel.binaryType = 'arraybuffer'

      if (channel.label === 'ReliableDataChannel') connection.setChannels(channel)
      if (channel.label === 'UnreliableDataChannel') connection.setChannels(null, channel)
    }

    rtcConnection.onconnectionstatechange = () => {
      const state = rtcConnection.connectionState
      debug('Server RTC state changed', state)
      if (state === 'connected') this.emit('openConnection', connection)
      if (state === 'closed' || state === 'disconnected' || state === 'failed') {
        this.emit('closeConnection', signal.connectionId, 'disconnected')
      }
    }

    rtcConnection.oniceconnectionstatechange = () => {
      const state = rtcConnection.iceConnectionState
      debug('Server ICE state changed:', state)
      if (state === 'failed') {
        this.emit('closeConnection', signal.connectionId, 'disconnected')
      }
    }

    try {
      const offer = new RTCSessionDescription({ type: 'offer', sdp: signal.data })
      await rtcConnection.setRemoteDescription(offer)
      debug('Set remote description (offer)')

      const answer = await rtcConnection.createAnswer()
      await rtcConnection.setLocalDescription(answer)
      debug('Created and set local description (answer)')

      respond(
        new SignalStructure(SignalType.ConnectResponse, signal.connectionId, answer.sdp, signal.networkId)
      )
    } catch (err) {
      debug('Failed to handle offer:', err)
    }
  }

  processPacket (buffer, rinfo) {
    const parsedPacket = processSecurePacket(buffer, this.deserializer)
    debug('Received packet', parsedPacket)

    switch (parsedPacket.name) {
      case 'discovery_request':
        this.handleRequest(rinfo)
        break
      case 'discovery_response':
        break
      case 'discovery_message':
        this.handleMessage(parsedPacket, rinfo)
        break
      default:
        throw new Error('Unknown packet type')
    }
  }

  setAdvertisement (buffer) {
    this.advertisement = buffer
  }

  handleRequest (rinfo) {
    const data = this.advertisement

    if (!data) {
      throw new Error('Advertisement data not set yet')
    }

    const packetData = createPacketData('discovery_response', PACKET_TYPE.DISCOVERY_RESPONSE, this.networkId,
      {
        data: data.toString('hex')
      }
    )

    const packetToSend = prepareSecurePacket(this.serializer, packetData)
    this.socket.send(packetToSend, rinfo.port, rinfo.address)
  }

  handleMessage (packet, rinfo) {
    const data = packet.params.data
    if (data === 'Ping') {
      return
    }

    const respond = (signal) => {
      const packetData = createPacketData('discovery_message', PACKET_TYPE.DISCOVERY_MESSAGE, this.networkId,
        {
          recipient_id: BigInt(signal.networkId),
          data: signal.toString()
        }
      )

      const packetToSend = prepareSecurePacket(this.serializer, packetData)
      this.socket.send(packetToSend, rinfo.port, rinfo.address)
    }

    const signal = SignalStructure.fromString(data)

    signal.networkId = packet.params.sender_id

    switch (signal.type) {
      case SignalType.ConnectRequest:
        this.handleOffer(signal, respond)
        break
      case SignalType.CandidateAdd:
        this.handleCandidate(signal)
        break
    }
  }

  async listen () {
    this.socket = dgram.createSocket('udp4')

    this.socket.on('message', (buffer, rinfo) => {
      this.processPacket(buffer, rinfo)
    })

    await new Promise((resolve, reject) => {
      const failFn = e => reject(e)
      this.socket.once('error', failFn)
      this.socket.bind(7551, () => {
        this.socket.removeListener('error', failFn)
        resolve(true)
      })
    })
  }

  close (reason) {
    debug('Closing server', reason)
    for (const conn of this.connections.values()) {
      conn.close()
    }

    this.socket.close(() => {
      this.emit('close', reason)
      this.removeAllListeners()
    })
  }
}

module.exports = { Server }

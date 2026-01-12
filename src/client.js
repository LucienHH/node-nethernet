const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')
const { Connection } = require('./connection')
const { SignalType, SignalStructure } = require('./signalling')

const { getRandomUint64, createPacketData, prepareSecurePacket, processSecurePacket } = require('./util')
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = require('@roamhq/wrtc')
const { PACKET_TYPE, createSerializer, createDeserializer } = require('./serializer')

const debug = require('debug')('nethernet')

const PORT = 7551
const BROADCAST_ADDRESS = '255.255.255.255'
const SOCKET_CLOSE_TIMEOUT_MS = 100

class Client extends EventEmitter {
  constructor (networkId, broadcastAddress = BROADCAST_ADDRESS) {
    super()

    this.serverNetworkId = networkId

    this.broadcastAddress = broadcastAddress

    this.networkId = getRandomUint64()

    this.connectionId = getRandomUint64()

    this.socket = dgram.createSocket('udp4')

    this.socket.on('message', (buffer, rinfo) => {
      this.processPacket(buffer, rinfo)
    })

    this.socket.bind(() => {
      this.socket.setBroadcast(true)
    })

    this.serializer = createSerializer()
    this.deserializer = createDeserializer()

    this.responses = new Map()
    this.addresses = new Map()

    this.credentials = []

    this._signalHandler = this.sendDiscoveryMessage.bind(this)

    this.sendDiscoveryRequest()

    this.pingInterval = setInterval(() => {
      this.sendDiscoveryRequest()
    }, 2000)

    this._hasEmittedConnected = false
    this._pendingConnect = false
    this._externalSignaling = false
  }

  // Auto-detect external signalling when handler is replaced
  set signalHandler (handler) {
    this._signalHandler = handler
    this._externalSignaling = true
    debug('Signal handler set, external signaling:', this._externalSignaling)
  }

  get signalHandler () {
    return this._signalHandler
  }

  async handleCandidate (signal) {
    try {
      if (!this.rtcConnection) {
        debug('No RTC connection, ignoring candidate')
        return
      }

      const candidate = new RTCIceCandidate({ candidate: signal.data, sdpMid: '0', sdpMLineIndex: 0 })

      await this.rtcConnection.addIceCandidate(candidate)
      debug('Added remote ICE candidate')
    } catch (err) {
      debug('Failed to add remote candidate:', err)
    }
  }

  async handleAnswer (signal) {
    try {
      const answer = new RTCSessionDescription({ type: 'answer', sdp: signal.data })
      await this.rtcConnection.setRemoteDescription(answer)
      debug('Set remote description (answer)')
    } catch (err) {
      debug('Failed to set remote description:', err)
    }
  }

  async createOffer () {
    debug('Creating RTCPeerConnection with ICE servers:', this.credentials)

    this.rtcConnection = new RTCPeerConnection({ iceServers: this.credentials })

    this.connection = new Connection(this, this.connectionId, this.rtcConnection)

    this.rtcConnection.onicecandidate = (event) => {
      if (event.candidate) {
        debug('Sending CandidateAdd to networkId:', this.serverNetworkId)
        const signal = new SignalStructure(SignalType.CandidateAdd, this.connectionId, event.candidate.candidate, this.serverNetworkId)

        this._signalHandler(signal)
      }
    }

    this.rtcConnection.onconnectionstatechange = () => {
      const state = this.rtcConnection.connectionState
      debug('Client connection state changed:', state)
      if (state === 'connected' && !this._hasEmittedConnected) {
        this._hasEmittedConnected = true
        this.emit('connected', this.connection)
      }
      if (state === 'closed' || state === 'disconnected' || state === 'failed') {
        this.emit('disconnect', this.connectionId, 'disconnected')
      }
    }

    this.rtcConnection.oniceconnectionstatechange = () => {
      const state = this.rtcConnection.iceConnectionState
      debug('Client ICE state changed:', state)
      if (state === 'failed') {
        this.emit('disconnect', this.connectionId, 'disconnected')
      }
    }

    const reliableChannel = this.rtcConnection.createDataChannel('ReliableDataChannel', { ordered: true })
    const unreliableChannel = this.rtcConnection.createDataChannel('UnreliableDataChannel', { ordered: false, maxRetransmits: 0 })

    reliableChannel.binaryType = 'arraybuffer'
    unreliableChannel.binaryType = 'arraybuffer'

    this.connection.setChannels(reliableChannel, unreliableChannel)

    try {
      const offer = await this.rtcConnection.createOffer()

      await this.rtcConnection.setLocalDescription(offer)

      const localDesc = this.rtcConnection.localDescription

      this._signalHandler(
        new SignalStructure(SignalType.ConnectRequest, this.connectionId, localDesc.sdp, this.serverNetworkId)
      )
    } catch (err) {
      debug('Failed to create offer:', err)
      this.emit('error', new Error(`Failed to create offer: ${err.message}`))
    }
  }

  processPacket (buffer, rinfo) {
    const parsedPacket = processSecurePacket(buffer, this.deserializer)
    debug('Received packet', parsedPacket)

    switch (parsedPacket.name) {
      case 'discovery_request':
        break
      case 'discovery_response':
        this.handleResponse(parsedPacket, rinfo)
        break
      case 'discovery_message':
        this.handleMessage(parsedPacket)
        break
      default:
        throw new Error('Unknown packet type')
    }
  }

  handleResponse (packet, rinfo) {
    const senderId = BigInt(packet.params.sender_id)
    this.addresses.set(senderId, rinfo)
    this.responses.set(senderId, packet.params)
    this.emit('pong', packet.params)

    // If connect() was called before discovery completed, initiate connection now
    const serverIdMatches = senderId.toString() === this.serverNetworkId.toString()
    if (this._pendingConnect && serverIdMatches) {
      this._pendingConnect = false
      this.createOffer()
    }
  }

  handleMessage (packet) {
    const data = packet.params.data

    if (data === 'Ping') {
      return
    }

    const signal = SignalStructure.fromString(data)

    signal.networkId = packet.params.sender_id

    this.handleSignal(signal)
  }

  handleSignal (signal) {
    switch (signal.type) {
      case SignalType.ConnectResponse:
        this.handleAnswer(signal)
        break
      case SignalType.CandidateAdd:
        this.handleCandidate(signal)
        break
    }
  }

  sendDiscoveryRequest () {
    const packetData = createPacketData('discovery_request', PACKET_TYPE.DISCOVERY_REQUEST, this.networkId)

    const packetToSend = prepareSecurePacket(this.serializer, packetData)

    this.socket.send(packetToSend, PORT, this.broadcastAddress)
  }

  sendDiscoveryMessage (signal) {
    const rinfo = this.addresses.get(BigInt(signal.networkId))

    const packetData = createPacketData('discovery_message', PACKET_TYPE.DISCOVERY_MESSAGE, this.networkId,
      {
        recipient_id: BigInt(signal.networkId),
        data: signal.toString()
      }
    )

    const packetToSend = prepareSecurePacket(this.serializer, packetData)
    this.socket.send(packetToSend, rinfo.port, rinfo.address)
  }

  connect () {
    this.running = true

    const hasAddress = this.addresses.has(this.serverNetworkId)

    if (this._externalSignaling || hasAddress) {
      this.createOffer()
    } else {
      this._pendingConnect = true
    }
  }

  send (buffer) {
    this.connection.send(buffer)
  }

  ping () {
    this.running = true

    this.sendDiscoveryRequest()
  }

  close (reason) {
    debug('Closing client', reason)
    if (!this.running) return
    clearInterval(this.pingInterval)
    this.connection?.close()
    setTimeout(() => this.socket.close(), SOCKET_CLOSE_TIMEOUT_MS)
    this.connection = null
    this.running = false
    this.removeAllListeners()
  }
}

module.exports = { Client }

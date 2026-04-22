import EventEmitter from 'node:events'
import { RemoteInfo, Socket } from 'node:dgram'
import { PeerConnection, DataChannel, IceServer } from 'node-datachannel'

declare module 'nethernet' {

  export interface ResponsePacket {
    binary: number[]
    buffer: Buffer
    writeIndex: number
    readIndex: number
    id: number
    packetLength: number
    senderId: bigint
    data: Buffer
  }

  export class Connection {
    nethernet: Client | Server;
    address: bigint;
    rtcConnection: PeerConnection;
    reliable: DataChannel | null;
    unreliable: DataChannel | null;
    promisedSegments: number;
    buf: Buffer | null;
    sendQueue: Buffer[];

    constructor(nethernet: Client | Server, address: bigint, rtcConnection: PeerConnection);
    setChannels(reliable?: DataChannel | null, unreliable?: DataChannel | null): void;
    handleMessage(data: Buffer | string | ArrayBuffer): void;
    send(data: Buffer | string): number;
    sendNow(data: Buffer): number;
    flushQueue(): void;
    close(): void;
  }

  export interface ServerOptions {
    networkId?: bigint;
    credentials?: (string | IceServer)[];
    iceServers?: (string | IceServer)[];
    acceptTimeoutMs?: number;
  }

  export interface ServerEvents {
    openConnection: (connection: Connection) => void;
    closeConnection: (connectionId: bigint, reason: string) => void;
    encapsulated: (data: Buffer, connectionId: bigint) => void;
    close: (reason?: string) => void;
  }

  export class Server extends EventEmitter {
    options: ServerOptions;
    credentials: (string | IceServer)[];
    acceptTimeoutMs: number;
    networkId: bigint;
    connections: Map<bigint, Connection>;
    advertisement?: Buffer;
    socket: Socket;
    serializer: any;
    deserializer: any;

    constructor(options?: ServerOptions);
    handleCandidate(signal: SignalStructure): Promise<void>;
    handleOffer(signal: SignalStructure, respond: (signal: SignalStructure) => void, credentials?: (string | IceServer)[]): Promise<void>;
    processPacket(buffer: Buffer, rinfo: RemoteInfo): void;
    setAdvertisement(buffer: Buffer): void;
    handleRequest(rinfo: RemoteInfo): void;
    handleMessage(packet: any, rinfo: RemoteInfo): void;
    listen(): Promise<void>;
    close(reason?: string): void;

    on<K extends keyof ServerEvents>(event: K, listener: ServerEvents[K]): this;
    emit<K extends keyof ServerEvents>(event: K, ...args: Parameters<ServerEvents[K]>): boolean;
  }

  export interface ClientEvents {
    connected: (connection: Connection) => void;
    disconnect: (connectionId: bigint, reason: string) => void;
    encapsulated: (data: Buffer, connectionId: bigint) => void;
    pong: (packet: any) => void;
  }

  export interface ClientOptions {
    networkId?: bigint;
    connectionId?: bigint;
    credentials?: (string | IceServer)[];
    iceServers?: (string | IceServer)[];
    responseTimeoutMs?: number;
    inactivityTimeoutMs?: number;
  }

  export class Client extends EventEmitter {
    serverNetworkId: bigint;
    broadcastAddress: string;
    networkId: bigint;
    connectionId: bigint;
    socket: Socket;
    serializer: any;
    deserializer: any;
    responses: Map<bigint, any>;
    addresses: Map<bigint, RemoteInfo>;
    credentials: (string | IceServer)[];
    responseTimeoutMs: number;
    inactivityTimeoutMs: number;
    signalHandler: (signal: SignalStructure) => void;
    connection?: Connection;
    rtcConnection?: PeerConnection;
    pingInterval?: NodeJS.Timeout;
    running: boolean;

    constructor(networkId: bigint, broadcastAddress?: string);
    constructor(networkId: bigint, broadcastAddress: string | undefined, options: ClientOptions);
    handleCandidate(signal: SignalStructure): Promise<void>;
    handleAnswer(signal: SignalStructure): Promise<void>;
    createOffer(): Promise<void>;
    processPacket(buffer: Buffer, rinfo: RemoteInfo): void;
    handleResponse(packet: any, rinfo: RemoteInfo): void;
    handleMessage(packet: any): void;
    handleSignal(signal: SignalStructure): void;
    sendDiscoveryRequest(): void;
    sendDiscoveryMessage(signal: SignalStructure): void;
    connect(): Promise<void>;
    send(buffer: Buffer): void;
    ping(): void;
    close(reason?: string): void;

    on<K extends keyof ClientEvents>(event: K, listener: ClientEvents[K]): this;
    emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): boolean;
  }

  export enum SignalType {
    ConnectRequest = 'CONNECTREQUEST',
    ConnectResponse = 'CONNECTRESPONSE',
    CandidateAdd = 'CANDIDATEADD',
    ConnectError = 'CONNECTERROR'
  }

  export enum ErrorCode {
    None = 0,
    DestinationNotLoggedIn = 1,
    NegotiationTimeout = 2,
    WrongTransportVersion = 3,
    FailedToCreatePeerConnection = 4,
    ICE = 5,
    ConnectRequest = 6,
    ConnectResponse = 7,
    CandidateAdd = 8,
    InactivityTimeout = 9,
    FailedToCreateOffer = 10,
    FailedToCreateAnswer = 11,
    FailedToSetLocalDescription = 12,
    FailedToSetRemoteDescription = 13,
    NegotiationTimeoutWaitingForResponse = 14,
    NegotiationTimeoutWaitingForAccept = 15,
    IncomingConnectionIgnored = 16,
    SignalingParsingFailure = 17,
    SignalingUnknownError = 18,
    SignalingUnicastMessageDeliveryFailed = 19,
    SignalingBroadcastDeliveryFailed = 20,
    SignalingMessageDeliveryFailed = 21,
    SignalingTurnAuthFailed = 22,
    SignalingFallbackToBestEffortDelivery = 23,
    NoSignalingChannel = 24,
    NotLoggedIn = 25,
    SignalingFailedToSend = 26
  }

  export class SignalStructure {
    type: SignalType;
    connectionId: bigint;
    data: string;
    networkId?: bigint;

    constructor(type: SignalType, connectionId: bigint, data: string, networkId?: bigint);
    toString(): string;
    static fromString(message: string): SignalStructure;
  }

}

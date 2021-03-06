/// <reference path="../client.ts" />
/// <reference path="../codec/Codec.ts" />
/// <reference path="VoiceRecorder.ts" />

class CodecPoolEntry {
    instance: BasicCodec;
    owner: number;

    last_access: number;
}

class CodecPool {
    handle: VoiceConnection;
    codecIndex: number;
    name: string;
    type: CodecType;

    entries: CodecPoolEntry[] = [];
    maxInstances: number = 2;

    private _supported: boolean = true;

    initialize(cached: number) {
        for(let i = 0; i < cached; i++)
            this.ownCodec(i + 1).then(codec => {
                console.log(tr("Release again! (%o)"), codec);
                this.releaseCodec(i + 1);
            }).catch(error => {
                console.warn(tr("Disabling codec support for "), this.name);
                if(this._supported) {
                    createErrorModal(tr("Could not load codec driver"), tr("Could not load or initialize codec ") + this.name + "<br>" +
                        "Error: <code>" + JSON.stringify(error) + "</code>").open();
                }
                this._supported = false;
                console.error(error);
            });
    }

    supported() { return this._supported; }

    ownCodec?(clientId: number, create: boolean = true) : Promise<BasicCodec | undefined> {
        return new Promise<BasicCodec>((resolve, reject) => {
            if(!this._supported) {
                reject(tr("unsupported codec!"));
                return;
            }

            let freeSlot = 0;
            for(let index = 0; index < this.entries.length; index++) {
                if(this.entries[index].owner == clientId) {
                    this.entries[index].last_access = new Date().getTime();
                    if(this.entries[index].instance.initialized()) resolve(this.entries[index].instance);
                    else {
                        this.entries[index].instance.initialise().then((flag) => {
                            //TODO test success flag
                            this.ownCodec(clientId, false).then(resolve).catch(reject);
                        }).catch(error => {
                            console.error(tr("Could not initialize codec!\nError: %o"), error);
                            reject(tr("Could not initialize codec!"));
                        });
                    }
                    return;
                } else if(freeSlot == 0 && this.entries[index].owner == 0) {
                    freeSlot = index;
                }
            }

            if(!create) {
                resolve(undefined);
                return;
            }

            if(freeSlot == 0){
                freeSlot = this.entries.length;
                let entry = new CodecPoolEntry();
                entry.instance = audio.codec.new_instance(this.type);
                entry.instance.on_encoded_data = buffer => this.handle.handleEncodedVoicePacket(buffer, this.codecIndex);
                this.entries.push(entry);
            }
            this.entries[freeSlot].owner = clientId;
            this.entries[freeSlot].last_access = new Date().getTime();
            if(this.entries[freeSlot].instance.initialized())
                this.entries[freeSlot].instance.reset();
            else {
                this.ownCodec(clientId, false).then(resolve).catch(reject);
                return;
            }
            resolve(this.entries[freeSlot].instance);
        });
    }

    releaseCodec(clientId: number) {
        for(let index = 0; index < this.entries.length; index++)
            if(this.entries[index].owner == clientId) this.entries[index].owner = 0;
    }

    constructor(handle: VoiceConnection, index: number, name: string, type: CodecType){
        this.handle = handle;
        this.codecIndex = index;
        this.name = name;
        this.type = type;

        this._supported = this.type !== undefined && audio.codec.supported(this.type);
    }
}

enum VoiceConnectionType {
    JS_ENCODE,
    NATIVE_ENCODE
}

/* funny fact that typescript dosn't find this */
interface RTCPeerConnection {
    addStream(stream: MediaStream): void;
    getLocalStreams(): MediaStream[];
    getStreamById(streamId: string): MediaStream | null;
    removeStream(stream: MediaStream): void;
    createOffer(successCallback?: RTCSessionDescriptionCallback, failureCallback?: RTCPeerConnectionErrorCallback, options?: RTCOfferOptions): Promise<RTCSessionDescription>;
}

class VoiceConnection {
    client: TSClient;
    rtcPeerConnection: RTCPeerConnection;
    dataChannel: RTCDataChannel;

    voiceRecorder: VoiceRecorder;
    private _type: VoiceConnectionType = VoiceConnectionType.NATIVE_ENCODE;

    local_audio_stream: any;

    private codec_pool: CodecPool[] = [
        new CodecPool(this,0,tr("Speex Narrowband"), CodecType.SPEEX_NARROWBAND),
        new CodecPool(this,1,tr("Speex Wideband"), CodecType.SPEEX_WIDEBAND),
        new CodecPool(this,2,tr("Speex Ultra Wideband"), CodecType.SPEEX_ULTRA_WIDEBAND),
        new CodecPool(this,3,tr("CELT Mono"), CodecType.CELT_MONO),
        new CodecPool(this,4,tr("Opus Voice"), CodecType.OPUS_VOICE),
        new CodecPool(this,5,tr("Opus Music"), CodecType.OPUS_MUSIC)
    ];

    private vpacketId: number = 0;
    private chunkVPacketId: number = 0;
    private send_task: NodeJS.Timer;

    constructor(client) {
        this.client = client;
        this._type = settings.static_global("voice_connection_type", this._type);
        this.voiceRecorder = new VoiceRecorder(this);
        this.voiceRecorder.on_end = this.handleVoiceEnded.bind(this);
        this.voiceRecorder.on_start = this.handleVoiceStarted.bind(this);
        this.voiceRecorder.reinitialiseVAD();

        audio.player.on_ready(() => {
            log.info(LogCategory.VOICE, tr("Initializing voice handler after AudioController has been initialized!"));
            if(native_client) {
                this.codec_pool[0].initialize(2);
                this.codec_pool[1].initialize(2);
                this.codec_pool[2].initialize(2);
                this.codec_pool[3].initialize(2);
            }
            this.codec_pool[4].initialize(2);
            this.codec_pool[5].initialize(2);

            if(this.type == VoiceConnectionType.NATIVE_ENCODE)
                this.setup_native();
            else
                this.setup_js();
        });

        this.send_task = setInterval(this.sendNextVoicePacket.bind(this), 20);
    }

    native_encoding_supported() : boolean {
        if(!(window.webkitAudioContext || window.AudioContext || {prototype: {}} as typeof AudioContext).prototype.createMediaStreamDestination) return false; //Required, but not available within edge
        return true;
    }

    javascript_encoding_supported() : boolean {
        if(!(window.RTCPeerConnection || {prototype: {}} as typeof RTCPeerConnection).prototype.createDataChannel) return false;
        return true;
    }

    current_encoding_supported() : boolean {
        switch (this._type) {
            case VoiceConnectionType.JS_ENCODE:
                return this.javascript_encoding_supported();
            case VoiceConnectionType.NATIVE_ENCODE:
                return this.native_encoding_supported();
        }
        return false;
    }

    private setup_native() {
        log.info(LogCategory.VOICE, tr("Setting up native voice stream!"));
        if(!this.native_encoding_supported()) {
            log.warn(LogCategory.VOICE, tr("Native codec isnt supported!"));
            return;
        }

        this.voiceRecorder.on_data = undefined;

        let stream =  this.voiceRecorder.get_output_stream();
        stream.disconnect();

        if(!this.local_audio_stream)
            this.local_audio_stream = audio.player.context().createMediaStreamDestination();
        stream.connect(this.local_audio_stream);
    }

    private setup_js() {
        if(!this.javascript_encoding_supported()) return;

        this.voiceRecorder.on_data = this.handleVoiceData.bind(this);
    }

    get type() : VoiceConnectionType { return this._type; }
    set type(target: VoiceConnectionType) {
        if(target == this.type) return;
        this._type = target;

        if(this.type == VoiceConnectionType.NATIVE_ENCODE)
            this.setup_native();
        else
            this.setup_js();
        this.createSession();
    }

    codecSupported(type: number) : boolean {
        return this.codec_pool.length > type && this.codec_pool[type].supported();
    }

    voice_playback_support() : boolean {
        return this.dataChannel && this.dataChannel.readyState == "open";
    }

    voice_send_support() : boolean {
        if(this.type == VoiceConnectionType.NATIVE_ENCODE)
            return this.native_encoding_supported() && this.rtcPeerConnection.getLocalStreams().length > 0;
        else
            return this.voice_playback_support();
    }

    private voice_send_queue: {data: Uint8Array, codec: number}[] = [];
    handleEncodedVoicePacket(data: Uint8Array, codec: number){
        this.voice_send_queue.push({data: data, codec: codec});
    }

    private sendNextVoicePacket() {
        let buffer = this.voice_send_queue.pop_front();
        if(!buffer) return;
        this.sendVoicePacket(buffer.data, buffer.codec);
    }

    sendVoicePacket(data: Uint8Array, codec: number) {
        if(this.dataChannel) {
            this.vpacketId++;
            if(this.vpacketId > 65535) this.vpacketId = 0;
            let packet = new Uint8Array(data.byteLength + 2 + 3);
            packet[0] = this.chunkVPacketId++ < 5 ? 1 : 0; //Flag header
            packet[1] = 0; //Flag fragmented
            packet[2] = (this.vpacketId >> 8) & 0xFF; //HIGHT (voiceID)
            packet[3] = (this.vpacketId >> 0) & 0xFF; //LOW   (voiceID)
            packet[4] = codec; //Codec
            packet.set(data, 5);
            try {
                this.dataChannel.send(packet);
            } catch (e) {
                //TODO may handle error?
            }
        } else {
            console.warn(tr("Could not transfer audio (not connected)"));
        }
    }


    createSession() {
        if(!this.current_encoding_supported()) return false;

        if(this.rtcPeerConnection) {
            this.dropSession();
        }
        this._ice_use_cache = true;


        let config: RTCConfiguration = {};
        config.iceServers = [];
        config.iceServers.push({ urls: 'stun:stun.l.google.com:19302' });
        this.rtcPeerConnection = new RTCPeerConnection(config);
        const dataChannelConfig = { ordered: true, maxRetransmits: 0 };

        this.dataChannel = this.rtcPeerConnection.createDataChannel('main', dataChannelConfig);
        this.dataChannel.onmessage = this.onDataChannelMessage.bind(this);
        this.dataChannel.onopen = this.onDataChannelOpen.bind(this);
        this.dataChannel.binaryType = "arraybuffer";

        let sdpConstraints : RTCOfferOptions = {};
        sdpConstraints.offerToReceiveAudio = this._type == VoiceConnectionType.NATIVE_ENCODE;
        sdpConstraints.offerToReceiveVideo = false;

        this.rtcPeerConnection.onicecandidate = this.onIceCandidate.bind(this);

        if(this.local_audio_stream) { //May a typecheck?
            this.rtcPeerConnection.addStream(this.local_audio_stream.stream);
            console.log(tr("Adding stream (%o)!"), this.local_audio_stream.stream);
        }
        this.rtcPeerConnection.createOffer(this.onOfferCreated.bind(this), () => {
            console.error(tr("Could not create ice offer!"));
        }, sdpConstraints);
    }

    dropSession() {
        if(this.dataChannel) this.dataChannel.close();
        if(this.rtcPeerConnection) this.rtcPeerConnection.close();
        //TODO here!
    }

    _ice_use_cache: boolean = true;
    _ice_cache: any[] = [];
    handleControlPacket(json) {
        if(json["request"] === "answer") {
            console.log(tr("Set remote sdp! (%o)"), json["msg"]);
            this.rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(json["msg"])).catch(error => {
                console.log(tr("Failed to apply remote description: %o"), error); //FIXME error handling!
            });
            this._ice_use_cache = false;
            for(let msg of this._ice_cache) {
                this.rtcPeerConnection.addIceCandidate(new RTCIceCandidate(msg)).catch(error => {
                    console.log(tr("Failed to add remote cached ice candidate %s: %o"), msg, error);
                });
            }
        } else if(json["request"] === "ice") {
            if(!this._ice_use_cache) {
                console.log(tr("Add remote ice! (%s | %o)"), json["msg"], json);
                this.rtcPeerConnection.addIceCandidate(new RTCIceCandidate(json["msg"])).catch(error => {
                    console.log(tr("Failed to add remote ice candidate %s: %o"), json["msg"], error);
                });
            } else {
                console.log(tr("Cache remote ice! (%s | %o)"), json["msg"], json);
                this._ice_cache.push(json["msg"]);
            }
        } else if(json["request"] == "status") {
            if(json["state"] == "failed") {
                chat.serverChat().appendError(tr("Failed to setup voice bridge ({}). Allow reconnect: {}"), json["reason"], json["allow_reconnect"]);
                log.error(LogCategory.NETWORKING, tr("Failed to setup voice bridge (%s). Allow reconnect: %s"), json["reason"], json["allow_reconnect"]);
                if(json["allow_reconnect"] == true) {
                    this.createSession();
                }
                //TODO handle fail specially when its not allowed to reconnect
            }
        }
    }

    //Listeners
    onIceCandidate(event) {
        console.log(tr("Got ice candidate! Event:"));
        console.log(event);
        if (event) {
            if(event.candidate)
                this.client.serverConnection.sendData(JSON.stringify({
                    type: 'WebRTC',
                    request: "ice",
                    msg: event.candidate,
                }));
            else {
                this.client.serverConnection.sendData(JSON.stringify({
                    type: 'WebRTC',
                    request: "ice_finish"
                }));
            }
        }
    }

    onOfferCreated(localSession) {
        console.log(tr("Offer created and accepted"));
        this.rtcPeerConnection.setLocalDescription(localSession).catch(error => {
            console.log(tr("Failed to apply local description: %o"), error);
            //FIXME error handling
        });

        console.log(tr("Send offer: %o"), localSession);
        this.client.serverConnection.sendData(JSON.stringify({type: 'WebRTC', request: "create", msg: localSession}));
    }

    onDataChannelOpen(channel) {
        console.log(tr("Got new data channel! (%s)"), this.dataChannel.readyState);
        this.client.controlBar.updateVoice();
    }

    onDataChannelMessage(message) {
        if(this.client.controlBar.muteOutput) return;

        let bin = new Uint8Array(message.data);
        let clientId = bin[2] << 8 | bin[3];
        let packetId = bin[0] << 8 | bin[1];
        let codec = bin[4];
        //console.log("Client id " + clientId + " PacketID " + packetId + " Codec: " + codec);
        let client = this.client.channelTree.findClient(clientId);
        if(!client) {
            console.error(tr("Having  voice from unknown client? (ClientID: %o)"), clientId);
            return;
        }

        let codecPool = this.codec_pool[codec];
        if(!codecPool) {
            console.error(tr("Could not playback codec %o"), codec);
            return;
        }

        let encodedData;
        if(message.data.subarray)
            encodedData = message.data.subarray(5);
        else encodedData = new Uint8Array(message.data, 5);

        if(encodedData.length == 0) {
            client.getAudioController().stopAudio();
            codecPool.releaseCodec(clientId);
        } else {
            codecPool.ownCodec(clientId)
                .then(decoder => decoder.decodeSamples(client.getAudioController().codecCache(codec), encodedData))
                .then(buffer => client.getAudioController().playBuffer(buffer)).catch(error => {
                    console.error(tr("Could not playback client's (%o) audio (%o)"), clientId, error);
                    if(error instanceof Error)
                        console.error(error.stack);
                });
        }
    }

    private current_channel_codec() : number {
        return (this.client.getClient().currentChannel() || {properties: { channel_codec: 4}}).properties.channel_codec;
    }

    private handleVoiceData(data: AudioBuffer, head: boolean) {
        if(!this.voiceRecorder) return;
        if(!this.client.connected) return false;
        if(this.client.controlBar.muteInput) return;

        if(head) {
            this.chunkVPacketId = 0;
            this.client.getClient().speaking = true;
        }

        //TODO Use channel codec!
        const codec = this.current_channel_codec();
        this.codec_pool[codec].ownCodec(this.client.getClientId())
            .then(encoder => encoder.encodeSamples(this.client.getClient().getAudioController().codecCache(codec), data));
    }

    private handleVoiceEnded() {
        if(this.client && this.client.getClient())
            this.client.getClient().speaking = false;

        if(!this.voiceRecorder) return;
        if(!this.client.connected) return;
        console.log(tr("Local voice ended"));

        if(this.dataChannel)
            this.sendVoicePacket(new Uint8Array(0), this.current_channel_codec()); //TODO Use channel codec!
    }

    private handleVoiceStarted() {
        console.log(tr("Local voice started"));

        if(this.client && this.client.getClient())
            this.client.getClient().speaking = true;
    }
}
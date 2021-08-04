import WebSocket from 'ws';
import mqtt from 'mqtt';
import http from 'http';

//webserver receiver
const host = '0.0.0.0';
const port = 8000;

const requestListener = function (req, res) {
    res.writeHead(200);
    switch (req.url) {
        case "/?speaker=a":
            client.publish('nadi', '{"command": "Speakera", "value": "1"}')
            client.publish('nadi', '{"command": "Speakerb", "value": "0"}')
            break;
        case "/?speaker=b":
            client.publish('nadi', '{"command": "Speakera", "value": "0"}')
            client.publish('nadi', '{"command": "Speakerb", "value": "1"}')
            break

        case "/?headphones=true":
            client.publish('nadi', '{"command": "Speakera", "value": "0"}')
            client.publish('nadi', '{"command": "Speakerb", "value": "0"}')
            break;
        default:
            break;
    }
    res.end("My first server!");
};

const server = http.createServer(requestListener);
server.listen(port, host, () => {
    console.log(`Server is running on http://${host}:${port}`);
});


const ws = new WebSocket('ws://192.168.178.66:1780/jsonrpc');
ws.binaryType = 'arraybuffer';
ws.on('open', function open() {
  console.log('connected');
  ws.send('{"id":1,"jsonrpc":"2.0","method":"Server.GetStatus"}');
});

ws.on('close', function close() {
  console.log('disconnected');
});
let nadID = "";
let groupId = "";
let currentStream = "";
let requestId = 2;
let volume = {};
let ampData = {
    source: 'aux',
    Speakera: '1',
    Speakerb: '0',
}
//ugly but it works, prevents error on inital clearTimeout
let poweroffTimeout =  setTimeout(function(){}, 1); 
let ignoreIds = [];
let ampSource = "";

ws.on('message', function incoming(message) {
    const utf8decoder = new TextDecoder();
    const decoded = JSON.parse(utf8decoder.decode(message));
    if(ignoreIds.includes(decoded.id)) {
        return;
    }
    if(decoded.id === 1) {
        decoded.result.server.groups.forEach(group => {
            group.clients.forEach(element => {
                if(element.config.name === 'NADAMP_TEST') {
                    nadID = element.id;
                    volume = element.config.volume;
                    groupId = group.id;
                    currentStream = group.stream_id 
                }
            });
        });
    } else if(typeof decoded.method !== 'undefined' && decoded.params.id === nadID) {
        // Client Handlers
        if(decoded.method === 'Client.OnVolumeChanged') {
            setVolume(decoded.params.volume);
        }
    } else if(typeof decoded.method !== 'undefined' && decoded.params.id === groupId) {
        // Group Handlers
        if(decoded.method === 'Group.OnStreamChanged') {
            currentStream = decoded.params.stream_id
            // setSpeaker(currentStream)
        }
    } else if(typeof decoded.method !== 'undefined' && decoded.params.id === currentStream) {
        console.log(decoded)
        if(decoded.method === 'Stream.OnUpdate') {
            if(decoded.params.stream.status === 'playing') {
                console.log('sent wakeup')
                //make sure correct channel is set and amp is turned on
                client.publish('nadi','{"command": "source", "value": "AUX"}')
                client.publish('nadi','{"command": "power", "value": "1"}')
                ampSource = "AUX"

                clearTimeout(poweroffTimeout);
            } else if(
                    decoded.params.stream.status === 'idle' &&
                    ampSource === "AUX"
                ) {
                clearTimeout(poweroffTimeout);
                console.log('started poweroff countdown ')
                //@todo check if i can ping alternative input device
                poweroffTimeout = setTimeout(function(){
                    client.publish('nadi','{"command": "power", "value": "0"}')
                }, 15 * 60 * 1000); //turn off after 15 minutes of idle
            }
        }
    }
    return null;
});
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function setVolume(newVolume) {
    if(volume.muted !== newVolume.muted) {
        const request = {
            command: 'mute',
            value: newVolume.muted === true ? "1" : "0"
        };
        client.publish('nadi',JSON.stringify(request))
    }
    if(volume.percent !== newVolume.percent) {
        const diffPercent =  newVolume.percent - volume.percent;
        const direction = diffPercent > 0 ? "+" : "-";

        if(newVolume.percent % 2 === 1) {
            //we can't display this volume, send new volume to snapcast server
            if(direction === "+") {
                newVolume.percent++;
            } else {
                newVolume.percent--;
            }
            const requestSnapcast = {
                "id": requestId,
                "jsonrpc":"2.0",
                "method":"Client.SetVolume",
                "params": {
                    "id": nadID,
                    "volume": newVolume
                }
            }
            ws.send(JSON.stringify(requestSnapcast));
            requestId++;
        }
        const request = JSON.stringify({
            command: 'volumeLegacy',
            value: direction
        });
        let steps = Math.abs(diffPercent) / 2;
        for (let index = 0; index < steps; index++) {
            //we need to make sure that 
            await sleep(170);
            client.publish('nadi',request)
        }
    }
    volume = newVolume
}
var client  = mqtt.connect('mqtt://127.0.0.1:1883')
client.on('connect', function () {
    client.subscribe('nado')
})
//messages from amp
client.on("message", function (topic, payload) {
    const utf8decoder = new TextDecoder();
    const decoded = JSON.parse(utf8decoder.decode(payload));
    switch (decoded.command) {
        case "volume":
            let newPercent = volume.percent
            if(decoded.value === "+") {
                newPercent = newPercent + 2;
            } else {
                newPercent = newPercent - 2;

            }
            const newVolume = {
                muted: volume.muted,
                percent: newPercent
            }
            const requestSnapcast = {
                "id": requestId,
                "jsonrpc":"2.0",
                "method":"Client.SetVolume",
                "params": {
                    "id": nadID,
                    "volume": newVolume
                }
            }
            ignoreIds.push(requestId);
            requestId++;
            volume = newVolume;
            ws.send(JSON.stringify(requestSnapcast));
            break;
        case "source":
            ampSource = decoded.command.value
            break;
        default:
            ampData[decoded.command] = decoded.value
            break;
    }
  })
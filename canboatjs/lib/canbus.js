/**
 * Copyright 2018 Scott Bender (scott@scottbender.net)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const debug = require('debug')('canboatjs:canbus')
const Transform = require('stream').Transform
const isArray = require('lodash').isArray
const BitStream = require('bit-buffer').BitStream
const BitView = require('bit-buffer').BitView
const { toPgn } = require('./toPgn')
const Parser = require('./fromPgn').Parser
const _ = require('lodash')
const CanDevice = require('./candevice')
const spawn = require('child_process').spawn
const { getPlainPGNs } = require('./utilities')
const { encodeCanId, parseCanId } = require('./canId')
const { toActisenseSerialFormat, parseActisense } = require('./stringMsg')

const MSG_BUF_SIZE  			= 2000
const CANDUMP_DATA_INC_3		= 3
const CANDUMP_DATA_INC_2		= 2
const MAX_DATA_BYTES			= 223

// There are at least three variations in candump output
// format which are currently handled...
//
const FMT_TBD			= 0
const FMT_1			= 1	// Angstrom ex:	"<0x18eeff01> [8] 05 a0 be 1c 00 a0 a0 c0"
const FMT_2			= 2	// Debian ex:	"   can0  09F8027F   [8]  00 FC FF FF 00 00 FF FF"
const FMT_3			= 3	// candump log ex:	"(1502979132.106111) slcan0 09F50374#000A00FFFF00FFFF"


function CanbusStream (options) {
  if (!(this instanceof CanbusStream)) {
    return new CanbusStream(options)
  }

  Transform.call(this, {
    objectMode: true
  })

  this.plainText = false
  this.reconnect = options.reconnect || true
  this.options = options
  this.externalCanDevice = this.options.externalCanDevice === true; // ADDED
  this.start()

  const setProviderStatus = options.app && options.app.setProviderStatus
        ? (msg) => {
          options.app.setProviderStatus(options.providerId, msg)
        }
        : () => {}
  const setProviderError = options.app && options.app.setProviderError
        ? (msg) => {
          options.app.setProviderError(options.providerId, msg)
        }
        : () => {}

  if ( options.fromStdIn ) {
    return
  }

  var socketcan;

  try {
    socketcan = require('socketcan')
  } catch ( err ) {
    var msg = 'WARNING unable to load native socketcan interface'
    console.error(msg)
  }

  var that = this

  if ( options.app ) {
    options.app.on('nmea2000out', (msg) => {
      that.sendPGN(msg)
    })
    options.app.on('nmea2000JsonOut', (msg) => {
      that.sendPGN(msg)
    })
  }

  var canDevice = options.canDevice || 'can0'
  if ( !socketcan || this.options.useSocketCanWriter ) {
    this.socketCanWriter = null
    var hasWriter = spawn('sh', ['-c', 'which socketcan-writer'])

    hasWriter.on('close', code => {
      if ( code == 0 ) {
        debug('found socketcan-writer, starting...')
        setProviderStatus('Starting')
        this.socketCanWriter = spawn('sh',
                                     ['-c', `socketcan-writer ${canDevice}`])
        setProviderStatus(`Connected to ${canDevice}`)
        this.socketCanWriter.stderr.on('data', function (data) {
          console.error(data.toString())
        })
        this.socketCanWriter.on('close', function (code) {
          const msg = 'socketcan-writer process exited with code ' + code
          setProviderError(msg)
          console.error(msg)
          this.socketCanWriter = null
        })
        setTimeout(() => {
          if (!this.externalCanDevice) { // ADD THIS IF
            this.candevice = new CanDevice(this, options)
            this.candevice.start()
          }
        }, 5000)
      }
    })
  } else {
    try {
      console.log('[CanbusStream] Trying to create raw channel:', canDevice);
      this.channel = socketcan.createRawChannel(canDevice);
      console.log('[CanbusStream] Raw channel created:', canDevice);
      this.channel.addListener('onMessage', (msg) => {
        var pgn = parseCanId(msg.id)

        if ( that.candevice && that.candevice.cansend && pgn.src == that.candevice.address ) {
          return
        }

        pgn.timestamp = new Date().toISOString()
        if ( that.plainText ) {
          this.push(binToActisense(pgn, msg.data, msg.data.length))
        } else {
          that.push({ pgn, length: msg.data.length, data: msg.data })
        }
      });
      console.log('[CanbusStream] Listener added. Starting channel...');
      this.channel.start();
      console.log('[CanbusStream] Channel started.'); // Moved CanDevice creation down

      if (!this.externalCanDevice) { // ADD THIS IF
        console.log('[CanbusStream] Creating INTERNAL CanDevice...'); // MODIFIED LOG
        this.candevice = new CanDevice(this, options);
        console.log('[CanbusStream] INTERNAL CanDevice created. Starting it...'); // MODIFIED LOG
        this.candevice.start();
        console.log('[CanbusStream] INTERNAL CanDevice started.'); // MODIFIED LOG
      }
      setProviderStatus('Connected')
    } catch (e) {
      setProviderError(e.message)
      console.error(`[CanbusStream] ERROR unable to open canbus ${canDevice}:`, e); // Ensure this line is present
      console.error(e.stack); // Ensure this line is present
    }
  }
}

function binToActisense(pgn, data, length) {
  return (
    pgn.timestamp +
      `,${pgn.prio},${pgn.pgn},${pgn.src},${pgn.dst},${length},` +
      new Uint32Array(data)
      .reduce(function(acc, i) {
        acc.push(i.toString(16));
        return acc;
      }, [])
      .map(x => (x.length === 1 ? "0" + x : x))
      .join(",")
  );
}


require('util').inherits(CanbusStream, Transform)

CanbusStream.prototype.start = function () {
}

CanbusStream.prototype.sendPGN = function (msg) { // msg can be an object or an Actisense string
  let pgnObjectToSend;

  if (_.isString(msg)) {
    pgnObjectToSend = parseActisense(msg); // parseActisense is from ./stringMsg
    if (!pgnObjectToSend || typeof pgnObjectToSend.pgn === 'undefined') {
      console.error(`[CanbusStream] ERROR: parseActisense failed for string msg: ${msg}`);
      return;
    }
  } else if (_.isObject(msg)) {
    pgnObjectToSend = msg; // Assume it's a PGN object from an external CanDevice
                           // Its .src should already be correctly set by the caller.
  } else {
    console.error(`[CanbusStream] ERROR: Unknown message type for sendPGN: ${typeof msg}`);
    return;
  }

  // Ensure essential fields are present for encoding and logging
  if (typeof pgnObjectToSend.pgn === 'undefined' || typeof pgnObjectToSend.src === 'undefined') {
    console.error(`[CanbusStream] ERROR: PGN object to send is missing 'pgn' or 'src' field: ${JSON.stringify(pgnObjectToSend)}`);
    return;
  }
  // Default dst if not present
  if (typeof pgnObjectToSend.dst === 'undefined') {
    pgnObjectToSend.dst = 255;
  }

  // Outputting / Sending Logic
  if (this.options.fromStdIn) {
    // In Signal K piped mode, output JSON to stdout
    // The [CanDevice] log in candevice.js already shows the PGN object, so this can be just the write.
    process.stdout.write(JSON.stringify(pgnObjectToSend) + '\n');
  } else if (this.channel) { // Direct CAN mode (socketcan)
    const canid = encodeCanId(pgnObjectToSend); // encodeCanId is from ./canId
    const buffer = toPgn(pgnObjectToSend);      // toPgn is from ./toPgn

    if (typeof buffer === 'undefined') {
      console.error(`[CanbusStream] ERROR: toPgn() returned undefined for PGN object: ${JSON.stringify(pgnObjectToSend)}`);
      return;
    }

    console.log(`[CanbusStream] Attempting this.channel.send() for PGN: ${pgnObjectToSend.pgn}, Src: ${pgnObjectToSend.src}, Dst: ${pgnObjectToSend.dst}, BufLen: ${buffer.length}`);

    if (buffer.length > 8 || pgnObjectToSend.pgn == 126720) { // Handle multi-packet or specific PGNs
      const pgnPackets = getPlainPGNs(buffer); // getPlainPGNs is from ./utilities
      pgnPackets.forEach(pbuffer => {
        this.channel.send({ id: canid, ext: true, data: pbuffer });
      });
    } else {
      this.channel.send({ id: canid, ext: true, data: buffer });
    }
  } else if (this.socketCanWriter) {
    // Fallback to socketCanWriter if fromStdIn is false & no direct channel
    // Ensure toPgn and toActisenseSerialFormat are available
    const dataBufferForWriter = toPgn(pgnObjectToSend);
    if (typeof dataBufferForWriter === 'undefined') {
      console.error(`[CanbusStream] ERROR (socketCanWriter): toPgn() returned undefined for PGN object: ${JSON.stringify(pgnObjectToSend)}`);
      return;
    }
    const actisenseString = toActisenseSerialFormat(pgnObjectToSend.pgn, dataBufferForWriter, pgnObjectToSend.dst, pgnObjectToSend.src); // from ./stringMsg & ./toPgn
    this.socketCanWriter.stdin.write(actisenseString + '\n');
  } else {
    // This case should ideally not be reached if constructor logic for direct mode is sound
    // or if fromStdIn is true.
    console.log(`[CanbusStream] No output channel/pipe for PGN: ${JSON.stringify(pgnObjectToSend)} (Not in fromStdIn mode, no this.channel, no this.socketCanWriter)`);
  }
};

function readLine(that, line) {
  var candump_data_inc = CANDUMP_DATA_INC_3;

  if (line.length == 0 ) {
    return
  }

  if ( !that.format ) {
    //that.s
    if ( line.charAt(0) == '<' ) {
      that.format = FMT_1
    } else if ( line.charAt(0) == '(' ) {
      that.format = FMT_3
      console.error("candump format not supported")
    } else {
      that.format = FMT_2
    }
  }


  var canid
  var data
  var split = line.trim().split(' ').filter(s => s.length > 0)
  var len
  if ( that.format === FMT_3 ) {
    return
  } else if ( that.format === FMT_1 ) {
    canid = parseInt(split[0].substring(1, split[0].length-1), 16)
    data = split.slice(2)
    len = split[1].substring(1, split[1].length-1)
  } else if ( that.format === FMT_2 ) {
    canid = parseInt(split[1], 16)
    data = split.slice(3)
    len = split[2].substring(1, split[2].length-1)
  }

  //console.log(JSON.stringify(split))
  var pgn = parseCanId(canid)

  if ( that.candevice && pgn.src == that.candevice.address ) {
    //this is a message that we sent
    debug('got a message from me')
    return
  }

  pgn.timestamp = new Date().toISOString()

  that.push({ pgn: pgn, length: len, data })
}

CanbusStream.prototype._transform = function (chunk, encoding, done) {
  readLine(this, chunk.toString())
  done()
}

CanbusStream.prototype.end = function () {
  if ( this.socketCanWriter ) {
    debug('end, killing socketcan-writer process')
    this.socketCanWriter.kill()
   }
}


CanbusStream.prototype.pipe = function (pipeTo) {
  if ( !pipeTo.fromPgn ) {
    this.plainText = true
  }
  /*
  pipeTo.fromPgn.on('pgn', (pgn) => {
    if ( this.candevice ) {
      this.candevice.n2kMessage(pgn)
    }
  })
  */
  return CanbusStream.super_.prototype.pipe.call(this, pipeTo)
}


module.exports = CanbusStream

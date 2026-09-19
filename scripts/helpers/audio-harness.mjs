import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const playerSource = await readFile(new URL('../../pocket/PCMPlayerWorklet.js', import.meta.url), 'utf8');
const emitterSource = await readFile(new URL('../../pocket/EventEmitter.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../../app.js', import.meta.url), 'utf8');
const playerConstruction = appSource.match(/new PCMPlayerWorklet\(audioContext,\s*(\{[^}]+\})\)/);
assert.ok(playerConstruction, 'test the player options actually used by the app');
const playerOptions = vm.runInNewContext(`(${playerConstruction[1]})`);
export const sampleRate = 24000;
export const quantum = 128;

// Run the real wrapper, event emitter, and generated processor. MessagePort
// delivery is queued in both directions, including the initial capacity update.
export async function createPlayer({ instantiate = true } = {}) {
  const messages = [];
  const deliveries = [];
  const events = [];
  let Processor;
  let processor;
  let hostPort;
  const context = vm.createContext({
    console, Float32Array, Int16Array, currentTime: 0,
    Blob: class { constructor(parts) { this.source = parts.join(''); } },
    URL: { createObjectURL(blob) { return blob; }, revokeObjectURL() {} },
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage(message) {
          messages.push(message);
          deliveries.push(() => hostPort.onmessage({ data: message }));
        } };
      }
    },
    registerProcessor(name, constructor) { Processor = constructor; },
    AudioWorkletNode: class {
      constructor() {
        hostPort = this.port = { postMessage(message) {
          deliveries.push(() => processor.port.onmessage({ data: message }));
        } };
        processor = new Processor();
      }
      connect() {}
    },
    recordEvent(type, detail) { events.push({ type, detail }); },
  });
  vm.runInContext(emitterSource.replaceAll('export class ', 'class ') + `
    const originalEmit = EventEmitter.prototype.emit;
    EventEmitter.prototype.emit = function(type, detail) {
      recordEvent(type, detail);
      originalEmit.call(this, type, detail);
    };
  `, context);
  const audioContext = {
    sampleRate, currentTime: 0, state: 'running', destination: {},
    async resume() { this.state = 'running'; },
    async suspend() { this.state = 'suspended'; },
    createGain() {
      return { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {} }, connect() {} };
    },
    createAnalyser() { return {}; },
    audioWorklet: { async addModule(blob) { vm.runInContext(blob.source, context); } },
  };
  vm.runInContext(
    playerSource.replace(/^import .*\n/, '').replace('export class PCMPlayerWorklet', 'class PCMPlayerWorklet')
      + '\nglobalThis.PCMPlayerWorklet = PCMPlayerWorklet;', context,
  );
  const player = instantiate ? new context.PCMPlayerWorklet(audioContext, playerOptions) : null;
  if (player) await player.initPromise;

  function flushMessages() {
    let count = 0;
    while (deliveries.length > 0) {
      assert.ok(++count < 10000, 'message queue must settle');
      deliveries.shift()();
    }
  }
  function render() {
    flushMessages();
    const output = new Float32Array(quantum);
    if (audioContext.state === 'running' && processor) {
      processor.process([], [[output]], {});
      context.currentTime += quantum / sampleRate;
      audioContext.currentTime = context.currentTime;
    }
    flushMessages();
    return output;
  }
  flushMessages();
  return { player, get processor() { return processor; }, audioContext,
    PCMPlayerWorklet: context.PCMPlayerWorklet, messages, events, flushMessages, render };
}

// Nonzero, exactly representable PCM makes dropped/repeated/reordered audio and
// inserted silence observable without running an inference model or audio device.
export function samples(length, offset = 0) {
  return Float32Array.from({ length }, (_, i) => (offset + i + 1) / 1048576);
}

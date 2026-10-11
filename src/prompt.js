import { createInterface } from 'node:readline/promises';

function interrupted(signal = 'SIGINT') {
  const error = new Error('Input cancelled.');
  error.code = 'ABORT_ERR';
  error.signal = signal;
  return error;
}

function promptLabel(question) {
  return /\s$/u.test(question) ? question : `${question} `;
}

function hiddenPrompt(question, input, output) {
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = input.isPaused();
    let text = '';
    let completed = false;

    function finish(error, value) {
      if (completed) return;
      completed = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      try {
        input.setRawMode(wasRaw);
      } catch {
        error ??= new Error('Unable to restore terminal input mode.');
      }
      if (wasPaused) input.pause();
      try {
        output.write('\n');
      } catch {
        error ??= new Error('Unable to write to this terminal.');
      }
      if (error) reject(error);
      else resolve(value);
    }

    function onData(chunk) {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') return finish(undefined, text);
        if (character === '\u0003' || character === '\u0004') return finish(interrupted());
        if (character === '\u007f' || character === '\b') text = [...text].slice(0, -1).join('');
        else if (character === '\u0015') text = '';
        else if (character === '\u0017') text = text.replace(/\S+\s*$/u, '');
        else if (character >= ' ' && character !== '\u007f') text += character;
        if (text.length > 65536) return finish(new Error('Input is too long.'));
      }
    }
    function onEnd() { finish(new Error('Input ended before a value was entered.')); }
    function onError() { finish(new Error('Unable to read terminal input.')); }
    function onInterrupt() { finish(interrupted()); }
    function onTerminate() { finish(interrupted('SIGTERM')); }

    try {
      input.setRawMode(true);
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onError);
      process.once('SIGINT', onInterrupt);
      process.once('SIGTERM', onTerminate);
      output.write(promptLabel(question));
      input.resume();
    } catch {
      finish(new Error('Unable to read hidden input from this terminal.'));
    }
  });
}

/** Read a setup answer from the terminal; hidden answers are never echoed. */
export async function promptText(question, { hidden = false } = {}) {
  const input = process.stdin;
  const output = process.stderr;
  if (!input.isTTY || !output.isTTY || (hidden && typeof input.setRawMode !== 'function')) {
    throw new Error('Interactive setup requires a terminal. Use --server with --token-stdin or --token-file.');
  }
  if (hidden) return hiddenPrompt(question, input, output);

  const controller = new AbortController();
  const terminal = createInterface({ input, output });
  let answered = false;
  let ended = false;
  let interruptionSignal = 'SIGINT';
  const onInterrupt = () => controller.abort();
  const onTerminate = () => {
    interruptionSignal = 'SIGTERM';
    controller.abort();
  };
  const onClose = () => {
    if (answered) return;
    ended = true;
    controller.abort();
  };
  terminal.once('SIGINT', onInterrupt);
  terminal.once('close', onClose);
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    const answer = await terminal.question(promptLabel(question), { signal: controller.signal });
    answered = true;
    return answer;
  } catch (error) {
    if (error.code === 'ABORT_ERR') {
      if (ended) throw new Error('Input ended before a value was entered.');
      throw interrupted(interruptionSignal);
    }
    throw new Error('Unable to read terminal input.');
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    terminal.off('close', onClose);
    terminal.close();
  }
}

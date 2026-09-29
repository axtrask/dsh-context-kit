import { pathToFileURL } from 'node:url';
const base = 'C:/Users/pro100noob/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai';
const { Context } = await import(pathToFileURL(base + '/cordis/lib/index.js').href);

/* 1. Does cordis `waterfall` honour arguments passed to `next(...)`? */
{
  const root = new Context();
  root.on('probe/event', (options, next) => {
    // The documented-looking pattern: return a REPLACEMENT options object.
    return next({ ...options, marker: 'REPLACED' });
  });
  let received = null;
  const returned = root.waterfall('probe/event', { marker: 'ORIGINAL' }, (final) => {
    received = final;
    return final;
  });
  console.log('next(arg) reached the inner callback with:', JSON.stringify(received));
  console.log('waterfall returned:', JSON.stringify(returned));
}

/* 2. Can a listener mutate the options object instead? */
{
  const root = new Context();
  root.on('probe/event2', (options, next) => {
    options.marker = 'MUTATED';
    return next();
  });
  let received = null;
  root.waterfall('probe/event2', { marker: 'ORIGINAL' }, (final) => {
    received = final;
    return final;
  });
  console.log('mutation reached the inner callback with:', JSON.stringify(received));
}

/* 3. Can a listener mutate a FROZEN array, the way dsh-agent-loop freezes it? */
{
  const root = new Context();
  const messages = Object.freeze([{ id: 'a' }, { id: 'b' }]);
  root.on('probe/event3', (options, next) => {
    try {
      options.messages.splice(0, 1);
      console.log('splice on the frozen array: accepted');
    } catch (error) {
      console.log('splice on the frozen array THREW:', error.constructor.name);
    }
    try {
      options.messages.length = 0;
      console.log('length=0 on the frozen array: accepted');
    } catch (error) {
      console.log('length=0 on the frozen array THREW:', error.constructor.name);
    }
    try {
      options.messages = [{ id: 'c' }];
      console.log('reassigning options.messages: accepted');
    } catch (error) {
      console.log('reassigning options.messages THREW:', error.constructor.name);
    }
    return next();
  });
  let received = null;
  root.waterfall('probe/event3', Object.freeze({ messages }), (final) => {
    received = final;
    return final;
  });
  console.log('messages seen downstream:', JSON.stringify(received.messages));
}

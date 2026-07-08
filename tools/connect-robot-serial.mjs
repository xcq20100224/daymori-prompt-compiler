import { SerialPort } from 'serialport';

function parseArgs(argv) {
  const args = {
    list: false,
    port: '',
    baud: 115200,
    send: '',
    wait: 5000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--list') args.list = true;
    if (token === '--port' && argv[i + 1]) args.port = argv[i + 1];
    if (token === '--baud' && argv[i + 1]) args.baud = Number(argv[i + 1]);
    if (token === '--send' && argv[i + 1]) args.send = argv[i + 1];
    if (token === '--wait' && argv[i + 1]) args.wait = Number(argv[i + 1]);
  }

  return args;
}

async function listPorts() {
  const ports = await SerialPort.list();
  if (!ports.length) {
    console.log('No serial ports found.');
    return [];
  }

  console.log('Detected serial ports:');
  for (const p of ports) {
    const line = [
      p.path,
      p.friendlyName || '',
      p.manufacturer || '',
      p.pnpId || '',
    ]
      .filter(Boolean)
      .join(' | ');
    console.log(`- ${line}`);
  }

  return ports;
}

async function openAndProbe(options) {
  const ports = await SerialPort.list();
  const selected = options.port || (ports[0] && ports[0].path);

  if (!selected) {
    throw new Error('No serial port available to connect.');
  }

  console.log(`Connecting to ${selected} @ ${options.baud}...`);

  const port = new SerialPort({
    path: selected,
    baudRate: options.baud,
    autoOpen: false,
  });

  await new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });

  console.log('Serial port opened.');

  port.on('data', (buf) => {
    const ascii = buf.toString('utf8').replace(/[\r\n]+$/g, '');
    const hex = buf.toString('hex');
    console.log(`[RX] ascii="${ascii}" hex=${hex}`);
  });

  port.on('error', (err) => {
    console.error(`[SERIAL ERROR] ${err.message}`);
  });

  if (options.send) {
    const payload = options.send.endsWith('\n') ? options.send : `${options.send}\n`;
    await new Promise((resolve, reject) => {
      port.write(payload, (err) => {
        if (err) return reject(err);
        port.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
      });
    });
    console.log(`[TX] ${JSON.stringify(payload)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, options.wait));

  await new Promise((resolve) => {
    port.close(() => resolve());
  });

  console.log('Serial port closed.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    await listPorts();
    return;
  }

  await openAndProbe(args);
}

main().catch((err) => {
  console.error('[CONNECT FAILED]', err.message);
  process.exit(1);
});

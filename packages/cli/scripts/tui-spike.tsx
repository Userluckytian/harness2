import { render, useInput, useApp, Static, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

const HAS_INPUT = Boolean(process.stdin.isTTY);

const HISTORY_SEEDS: string[] = Array.from({ length: 30 }, (_, i) => `seed-history-line-${String(i).padStart(2, '0')}`);
const LIST_ITEMS: string[] = Array.from({ length: 4 }, (_, i) => `item-${i + 1}`);

type FocusZone = 'list' | 'composer';

function App() {
  const { exit } = useApp();
  const [focused, setFocused] = useState<FocusZone>('list');
  const [composer, setComposer] = useState('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [width, setWidth] = useState(0);

  useInput(
    (input, key) => {
      if (composer === '/exit') {
        setExitCode(0);
        return;
      }
      if (key.ctrl && input === 'c') {
        setExitCode(130);
        return;
      }
      if (key.tab) {
        setFocused((f) => (f === 'list' ? 'composer' : 'list'));
        return;
      }
      if (key.escape) {
        setComposer('');
        return;
      }
      if (key.backspace) {
        setComposer((c) => c.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && !key.return && input) {
        setComposer((c) => c + input);
      }
    },
    { isActive: HAS_INPUT },
  );

  useEffect(() => {
    void import('string-width').then((m) => {
      setWidth(m.default(composer));
    });
  }, [composer]);

  useEffect(() => {
    if (exitCode !== null) {
      exit(exitCode);
    }
  }, [exitCode, exit]);

  useEffect(() => {
    if (!HAS_INPUT) {
      process.stdout.write(`SPIKE_STRUCT History=${HISTORY_SEEDS.length} List=${LIST_ITEMS.length} Composer=1\n`);
      exit(0);
    }
  }, [exit]);

  return (
    <>
      <Static items={HISTORY_SEEDS}>{(line) => <Text key={line}>{line}</Text>}</Static>
      <Text color="gray">spike:history:</Text>
      <Text color="gray">spike:list:</Text>
      {focused === 'list'
        ? LIST_ITEMS.map((item) => (
            <Text key={item} color="green">
              &gt; {item}
            </Text>
          ))
        : LIST_ITEMS.map((item) => <Text key={item}>&gt; {item}</Text>)}
      <Text color="gray">spike:composer:</Text>
      <Box flexDirection="row">
        <Text color="green">&gt; </Text>
        <Text>{composer}</Text>
      </Box>
      <Text color="gray">
        spike:status focused={focused} width={width}
      </Text>
    </>
  );
}

render(<App />, { exitOnCtrlC: false });

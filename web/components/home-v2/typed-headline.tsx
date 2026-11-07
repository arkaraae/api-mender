'use client';

import { useEffect, useState } from 'react';

const LINES = ["APIs change. Your integrations shouldn't break.", 'Old apps keep working.', 'Nothing breaks.'];

// Starts with the full first line so the first frame reads well, then types through the others.
export default function TypedHeadline() {
  const [text, setText] = useState(LINES[0]);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let line = 0;
    let timer: ReturnType<typeof setTimeout>;
    let current = LINES[0];
    const erase = () => {
      if (current.length) {
        current = current.slice(0, -1); setText(current);
        timer = setTimeout(erase, 22);
      } else {
        line = (line + 1) % LINES.length;
        type(0);
      }
    };
    const type = (i: number) => {
      current = LINES[line].slice(0, i); setText(current);
      timer = setTimeout(i < LINES[line].length ? () => type(i + 1) : erase, i < LINES[line].length ? 45 : 2600);
    };
    timer = setTimeout(erase, 4200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <h1 className="mv2-typed" aria-label={LINES[0]}>
      <span aria-hidden="true">{text}</span><span className="mv2-caret" aria-hidden="true" />
    </h1>
  );
}

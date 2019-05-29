import { FormContentProps } from './defs';
import { getFormData } from '../defs';
import * as React from 'react';
import styled from '../../../util/styled';

type GraphemeSplitter = import('grapheme-splitter');
const GraphemeSplitter: new () => GraphemeSplitter = require('grapheme-splitter');

/**
 * Make a Poet1 (initial Poet) form.
 */
export function makePoet1Form({ form, t }: FormContentProps<'Poet1'>) {
  const data = getFormData(form);

  const content = (
    <>
      <p>{t('game_client_form:Poet.descriptionInit')}</p>
      <PoemTextArea
        placeholder={t('game_client_form:Poet.poemPlaceholder')}
        charPerLine={[5, 7, 5]}
      />
      <p>{t('game_client_form:Poet.targetSelectionLabel')}</p>
    </>
  );

  return content;
}

const PoemTextAreaWrapper = styled.div`
  width: 100%;
  max-width: 20em;
  margin: 0.8em 0;

  textarea {
    width: 100%;
  }
`;
/**
 * Textarea to input poem.
 */
const PoemTextArea = React.forwardRef<
  HTMLTextAreaElement,
  {
    placeholder?: string;
    charPerLine: number[];
  }
>(({ placeholder, charPerLine }, ref) => {
  const duringCompositionRef = React.useRef(false);
  const splitter = React.useMemo(() => new GraphemeSplitter(), []);
  return (
    <PoemTextAreaWrapper>
      <textarea
        ref={ref}
        placeholder={placeholder}
        rows={charPerLine.length}
        onChange={e => {
          if (!duringCompositionRef.current) {
            e.currentTarget.value = sanitize(
              e.currentTarget.value,
              splitter,
              charPerLine,
            );
          }
        }}
        onCompositionStart={() => (duringCompositionRef.current = true)}
        onCompositionEnd={e => {
          duringCompositionRef.current = false;
          const target = e.currentTarget;
          const nv = sanitize(e.currentTarget.value, splitter, charPerLine);
          setTimeout(() => {
            target.value = nv;
          }, 50);
        }}
      />
    </PoemTextAreaWrapper>
  );
});

function sanitize(
  text: string,
  splitter: GraphemeSplitter,
  charPerLine: number[],
): string {
  let result = '';
  let charCountInLine = 0;
  let lineNumber = 0;
  for (const char of splitter.iterateGraphemes(text)) {
    if (char === '\n') {
      if (lineNumber + 1 < charPerLine.length) {
        result += '\n';
      }
      charCountInLine = 0;
      lineNumber++;
      continue;
    }
    for (; lineNumber < charPerLine.length; lineNumber++) {
      const line = charPerLine[lineNumber];
      if (charCountInLine < line) {
        result += char;
        charCountInLine++;
        break;
      }
      if (lineNumber + 1 < charPerLine.length) {
        result += '\n';
      }
      charCountInLine = 0;
    }
    if (lineNumber >= charPerLine.length) {
      break;
    }
  }
  return result;
}

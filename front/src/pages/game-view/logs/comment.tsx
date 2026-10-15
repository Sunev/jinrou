import { LogSupplement } from '../defs';
import { memo, Fragment } from 'react';
import autolink, { compile } from 'my-autolink';
import React from 'react';
import { StoredLog } from './log-store';

export interface IPropCommentContent {
  comment: string;
  supplement?: LogSupplement[];
  resolveLogById?: (shortId: string) => StoredLog | null;
}

const GAP = 12;
const MAX_WIDTH = 360;
const REFERENCE_DOUBLE_CLICK_DELAY = 300;
const referenceTriggerStyle: React.CSSProperties = {
  cursor: 'pointer',
  textDecoration: 'underline',
  textDecorationColor: '#0066cc',
};

let tooltipElement: HTMLDivElement | null = null;
let currentTooltipShortId: string | null = null;
let currentResolveLogById: ((shortId: string) => StoredLog | null) | undefined;
let lastReferenceClickTime = 0;
let lastReferenceClickShortId: string | null = null;
let referenceClickResetTimer: number | null = null;

/**
 * Resolve reference text lazily so the full tooltip payload is not stored on
 * every reference node in the DOM.
 */
function resolveReferenceMessage(shortId: string): string | null {
  if (!currentResolveLogById) {
    return null;
  }
  const logobj = currentResolveLogById(shortId);
  if (logobj != null && 'comment' in logobj) {
    const playerName = 'name' in logobj ? logobj.name : undefined;
    return playerName != null && logobj.comment != null
      ? `${playerName}：\n${logobj.comment}`
      : logobj.comment != null
        ? logobj.comment
        : null;
  }
  return null;
}

function createTooltipElement(): HTMLDivElement {
  if (tooltipElement) {
    return tooltipElement;
  }
  const tooltip = document.createElement('div');
  tooltip.style.position = 'fixed';
  tooltip.style.transform = 'none';
  tooltip.style.backgroundColor = 'rgba(0,0,0,0.95)';
  tooltip.style.color = '#fff';
  tooltip.style.padding = '12px 16px';
  tooltip.style.borderRadius = '8px';
  tooltip.style.fontSize = '14px';
  tooltip.style.lineHeight = '1.4';
  tooltip.style.maxWidth = `${MAX_WIDTH}px`;
  tooltip.style.whiteSpace = 'pre-wrap';
  tooltip.style.wordBreak = 'break-word';
  tooltip.style.zIndex = '9999999';
  tooltip.style.boxShadow = '0 6px 24px rgba(0,0,0,0.5)';
  tooltip.style.pointerEvents = 'auto';

  const content = document.createElement('div');
  content.style.fontSize = '13px';
  tooltip.appendChild(content);
  document.body.appendChild(tooltip);
  tooltipElement = tooltip;
  document.addEventListener('click', handleDocumentClick);
  return tooltip;
}

function hideReferenceTooltip() {
  if (tooltipElement) {
    tooltipElement.style.display = 'none';
  }
  currentTooltipShortId = null;
}

function placeTooltip(tooltip: HTMLDivElement, pos: { x: number; y: number }) {
  tooltip.style.left = `${pos.x}px`;
  tooltip.style.top = `${pos.y}px`;
  tooltip.style.display = 'block';

  const rect = tooltip.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const safe = 8;

  const spaceAbove = pos.y;
  const spaceBelow = vh - pos.y;
  let top = 0;
  if (spaceAbove >= rect.height + GAP) {
    top = pos.y - rect.height - GAP;
  } else if (spaceBelow >= rect.height + GAP) {
    top = pos.y + GAP;
  } else {
    top = spaceAbove > spaceBelow ? safe : vh - rect.height - safe;
  }

  const spaceLeft = pos.x;
  const spaceRight = vw - pos.x;
  let left = 0;
  if (spaceRight >= rect.width / 2 && spaceLeft >= rect.width / 2) {
    left = pos.x - rect.width / 2;
  } else if (spaceRight >= rect.width) {
    left = pos.x + GAP;
  } else if (spaceLeft >= rect.width) {
    left = pos.x - rect.width - GAP;
  } else {
    left = spaceRight > spaceLeft ? safe : vw - rect.width - safe;
  }

  left = Math.min(Math.max(left, safe), vw - rect.width - safe);
  top = Math.min(Math.max(top, safe), vh - rect.height - safe);

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function showReferenceTooltip(shortId: string, pos: { x: number; y: number }) {
  if (currentTooltipShortId === shortId && tooltipElement) {
    hideReferenceTooltip();
    return;
  }

  const tooltip = createTooltipElement();
  const content = tooltip.firstChild as HTMLDivElement;
  content.textContent = resolveReferenceMessage(shortId) || '未找到对应发言';
  currentTooltipShortId = shortId;
  placeTooltip(tooltip, pos);
}

function navigateToReference(shortId: string) {
  hideReferenceTooltip();
  const targetElement = document.querySelector(
    `[data-shortid="${shortId}"]`,
  ) as HTMLElement;
  if (targetElement) {
    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    targetElement.style.transition = 'background-color 0.3s ease';
    const originalBg = targetElement.style.backgroundColor;
    targetElement.style.backgroundColor = 'rgba(255, 255, 0, 0.3)';
    window.setTimeout(() => {
      targetElement.style.backgroundColor = originalBg;
    }, 1500);
  }
}

function handleDocumentClick(e: Event) {
  if (!tooltipElement || tooltipElement.style.display === 'none') {
    return;
  }
  const target = e.target as HTMLElement;
  if (tooltipElement.contains(target)) {
    return;
  }
  if (target && target.closest('[data-tooltip-trigger]')) {
    return;
  }
  hideReferenceTooltip();
}

function handleReferenceClick(e: React.MouseEvent<HTMLElement>) {
  const shortId = e.currentTarget.getAttribute('data-reference-shortid');
  if (!shortId) {
    return;
  }

  const now = Date.now();
  const timeDiff = now - lastReferenceClickTime;
  const isDoubleClick =
    lastReferenceClickShortId === shortId &&
    timeDiff < REFERENCE_DOUBLE_CLICK_DELAY &&
    timeDiff > 0;

  if (isDoubleClick) {
    e.stopPropagation();
    if (referenceClickResetTimer != null) {
      window.clearTimeout(referenceClickResetTimer);
      referenceClickResetTimer = null;
    }
    lastReferenceClickTime = 0;
    lastReferenceClickShortId = null;
    navigateToReference(shortId);
    return;
  }

  showReferenceTooltip(shortId, {
    x: e.clientX,
    y: e.clientY,
  });
  lastReferenceClickTime = now;
  lastReferenceClickShortId = shortId;
  if (referenceClickResetTimer != null) {
    window.clearTimeout(referenceClickResetTimer);
  }
  referenceClickResetTimer = window.setTimeout(() => {
    lastReferenceClickTime = 0;
    lastReferenceClickShortId = null;
    referenceClickResetTimer = null;
  }, REFERENCE_DOUBLE_CLICK_DELAY);
}

const LogReference = React.memo<{
  shortId: string;
  playerName?: string;
}>(({ shortId, playerName }) => {
  return (
    <b
      data-tooltip-trigger="true"
      data-reference-shortid={shortId}
      onClick={handleReferenceClick}
      style={referenceTriggerStyle}
      title="单击查看引用，双击跳转到原消息"
    >
      {playerName ? (
        `>>${shortId}:${playerName}`
      ) : (
        <>
          {'>>'}
          {shortId}
        </>
      )}
    </b>
  );
});

const autolinkSetting = compile(
  [
    'url',
    {
      pattern() {
        return /#(\d+)/g;
      },
      transform(_1, _2, num) {
        return {
          href: `/room/${num}`,
        };
      },
    },
  ],
  {
    url: {
      attributes: {
        rel: 'external',
      },
      text: url => {
        // Convert any room URL to room number syntax.
        const orig = location.origin;
        if (url.slice(0, orig.length) === orig) {
          const r = url.slice(orig.length).match(/^\/room\/(\d+)$/);
          if (r != null) {
            return `#${r[1]}`;
          }
        }
        return url;
      },
    },
  },
);

export const CommentContent: React.FunctionComponent<
  IPropCommentContent
> = memo(({ comment, supplement, resolveLogById }) => {
  currentResolveLogById = resolveLogById;
  // 检查是否包含特殊命令（骰子或引用）
  const hasSpecialCommand = /!(\d+)[dD](\d+)|>>\s*\d+/.test(comment);

  if (!hasSpecialCommand) {
    return (
      <span
        dangerouslySetInnerHTML={{
          __html: autolink(comment, autolinkSetting),
        }}
      />
    );
  }

  // perform calculation of special commands.
  const commandr = /!(\d+)[dD](\d+)|>>\s*(\d+)/g;
  const nodes: React.ReactNode[] = [];
  let currentIndex = 0;
  let supplementIndex = 0;
  let res;
  while ((res = commandr.exec(comment))) {
    // 1. 把普通文本补进去
    if (res.index > currentIndex) {
      nodes.push(comment.slice(currentIndex, res.index));
    }
    currentIndex = commandr.lastIndex;

    // ======================
    // 2. 处理骰子 !XdY
    // ======================
    if (res[1] != null) {
      if (!supplement) {
        nodes.push(res[0]);
        continue;
      }
      const sup = supplement[supplementIndex++];

      if (sup == null || sup.type !== 'dice') {
        nodes.push(res[0]);
        continue;
      }

      const { result } = sup;
      if (!result || result.length === 0) {
        nodes.push(res[0]);
        continue;
      }

      // dice result
      if (result.length === 1) {
        nodes.push(
          <b key={`dice-${res.index}`}>
            【{res[1]}D{res[2]}={result[0]}】
          </b>,
        );
      } else {
        const sum = result.reduce((a, b) => a + b, 0);
        nodes.push(
          <b key={`dice-${res.index}`}>
            【{res[1]}D{res[2]}={sum}({result.join('+')}
            )】
          </b>,
        );
      }
      continue;
    }

    // ======================
    // 3. 处理 >>y 引用
    // ======================
    if (res[3] != null) {
      const shortId = res[3]; // 不再需要补齐，直接使用原始数字
      let playerName = undefined;

      if (resolveLogById) {
        const logobj = resolveLogById(shortId);
        if (logobj != null) {
          playerName = 'name' in logobj ? logobj.name : undefined;
        }
      }

      nodes.push(
        <LogReference
          key={`ref-${res.index}`}
          shortId={shortId}
          playerName={playerName}
        />,
      );
      continue;
    }
  }

  if (currentIndex < comment.length) {
    nodes.push(comment.slice(currentIndex));
  }

  return (
    <>
      {nodes.map(
        (node, i) =>
          typeof node === 'string' ? (
            <Fragment key={i}>
              <span
                dangerouslySetInnerHTML={{
                  __html: autolink(node, autolinkSetting),
                }}
              />
            </Fragment>
          ) : (
            <Fragment key={i}>{node}</Fragment>
          ),
      )}
    </>
  );
});

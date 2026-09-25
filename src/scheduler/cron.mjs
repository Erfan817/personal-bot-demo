/**
 * 调度层 · 极简 cron 解析器
 * ═══════════════════════════════════════════════════
 * 5 个字段：  分  时  日  月  周
 *             *   *   *   *   *
 *
 * 支持：*  /  数字  /  a-b 范围  /  a,b 列表  /  *\/n 步长
 *
 * 注意注释里写 *\/ 的写法：因为「星号 + 斜杠」在块注释里
 * 就是【注释结束符】，不转义的话注释会被提前闭合，
 * 后面的字会变成代码 —— 典型的语法错误来源。
 *
 * 例：
 *   0 8 * * *      每天 08:00
 *   30 9 * * 1-5   周一到周五 09:30
 *   *\/30 * * * *   每 30 分钟
 *   0 9,18 * * *   每天 09:00 和 18:00
 *
 * 注意：用的是【服务器本地时间】——所以第 ② 步改的时区在这里兑现价值。
 */

/** 解析单个字段成"可选值集合" */
function parseField(expr, min, max) {
  const set = new Set();

  for (const part of String(expr).split(",")) {
    // */n  或  a-b/n  或  a/n
    const stepMatch = part.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/);
    if (stepMatch) {
      const [, range, stepStr] = stepMatch;
      const step = Number(stepStr);
      if (step <= 0) throw new Error(`步长必须大于 0: "${part}"`);

      let start = min;
      let end = max;
      if (range !== "*") {
        const [a, b] = range.split("-").map(Number);
        start = a;
        end = b;
      }
      for (let i = start; i <= end; i += step) set.add(i);
      continue;
    }

    // *
    if (part === "*") {
      for (let i = min; i <= max; i++) set.add(i);
      continue;
    }

    // a-b
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      for (let i = Number(rangeMatch[1]); i <= Number(rangeMatch[2]); i++) {
        set.add(i);
      }
      continue;
    }

    // 单个数字
    if (/^\d+$/.test(part)) {
      set.add(Number(part));
      continue;
    }

    throw new Error(`看不懂的 cron 字段: "${part}"`);
  }

  return set;
}

export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 必须是 5 段（分 时 日 月 周），收到: "${expr}"`);
  }

  const [mi, ho, dom, mon, dow] = parts;

  return {
    expr,
    minute: parseField(mi, 0, 59),
    hour: parseField(ho, 0, 23),
    dayOfMonth: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12),
    dayOfWeek: parseField(dow, 0, 6),

    // 记住这两个字段有没有被"限制"，见下方 dayMatches 的说明
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

/**
 * 「日」和「周」的关系是 cron 里最容易搞错的地方：
 *
 *   · 两个都是 *      -> 每天都匹配
 *   · 只有一个被限制   -> 只看被限制的那个
 *   · 两个都被限制     -> 【或】关系（任一满足即可）
 *
 * 如果无脑写成 `dom.has(d) || dow.has(d)`，
 * 那么 dom=15 且 dow=* 时会永远为真（因为 dow 全匹配）——
 * 这是一个很常见的 bug。
 */
function dayMatches(cron, date) {
  if (!cron.domRestricted && !cron.dowRestricted) return true;
  if (cron.domRestricted && !cron.dowRestricted) {
    return cron.dayOfMonth.has(date.getDate());
  }
  if (!cron.domRestricted && cron.dowRestricted) {
    return cron.dayOfWeek.has(date.getDay());
  }
  return (
    cron.dayOfMonth.has(date.getDate()) || cron.dayOfWeek.has(date.getDay())
  );
}

/** 这个时间点是否命中该 cron */
export function matches(cron, date) {
  return (
    cron.minute.has(date.getMinutes()) &&
    cron.hour.has(date.getHours()) &&
    cron.month.has(date.getMonth() + 1) &&
    dayMatches(cron, date)
  );
}
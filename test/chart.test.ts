import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ChartError,
  chartContent,
  chartDigest,
  chartFromTable,
  chartLayout,
  chartModel,
  describeChartChange,
  findPoint,
  formatValue,
  niceTicks,
  parseNumber,
  pointQuote,
  textWidth,
  tickLabel,
  type ChartContent,
  type ChartInput,
} from '../src/core/blocks/chart/chart';

const WEEK: ChartInput = {
  kind: 'bar',
  columns: ['Day', 'Done'],
  rows: [
    ['Mon', '3'],
    ['Tue', '8'],
    ['Wed', '12'],
    ['Thu', '16'],
    ['Fri', '14'],
  ],
  unit: 'tasks',
};

const TWO: ChartInput = {
  kind: 'line',
  columns: ['Day', 'Opened', 'Done'],
  rows: [
    ['Mon', 14, 6],
    ['Tue', 28, 18],
    ['Wed', 41, 34],
    ['Thu', 52, 49],
    ['Fri', 61, 58],
  ],
  unit: 'tasks',
};

const refuses = (input: ChartInput, message: RegExp) => assert.throws(() => chartContent(input), (e: Error) => e instanceof ChartError && message.test(e.message));

describe('Chart numbers', () => {
  it('reads numbers as people write them, with an empty cell as a gap', () => {
    assert.equal(parseNumber('1,234'), 1234);
    assert.equal(parseNumber('12%'), 12);
    assert.equal(parseNumber(' -3.5 '), -3.5);
    assert.equal(parseNumber('−2'), -2);
    assert.equal(parseNumber('$1,200.50'), 1200.5);
    assert.equal(parseNumber('.5'), 0.5);
    assert.equal(parseNumber(42), 42);
    assert.equal(parseNumber(''), null);
    assert.equal(parseNumber('   '), null);
    assert.equal(parseNumber(null), null);
    for (const word of ['n/a', '1,23', '12 tasks', 'about 5', '1.2.3', '%', '-']) assert.equal(parseNumber(word), undefined, word);
  });

  it('formats values with their unit, and ticks compactly', () => {
    assert.equal(formatValue(16, 'tasks'), '16 tasks');
    assert.equal(formatValue(1234.5, 'ms'), '1,234.5 ms');
    assert.equal(formatValue(12, '%'), '12%');
    assert.equal(formatValue(-1200, '$'), '−$1,200');
    assert.equal(formatValue(null, 'tasks'), 'no value');
    assert.equal(tickLabel(1500, 'tasks'), '1.5K'); // a word unit goes on the axis caption, not every tick
    assert.equal(tickLabel(20, '%'), '20%');
    assert.equal(tickLabel(200, 'ms'), '200 ms');
    assert.equal(tickLabel(2_000_000), '2M');
    assert.equal(tickLabel(1250, 'ms'), '1.25K ms'); // exact, not 1.3K
  });

  it('makes round ticks: 1, 2, 2.5 or 5 times a power of ten, whole when the data is', () => {
    assert.deepEqual(niceTicks(0, 16, 4, true), [0, 5, 10, 15, 20]);
    assert.deepEqual(niceTicks(0, 61, 4), [0, 20, 40, 60, 80]);
    assert.deepEqual(niceTicks(0, 0.8, 4), [0, 0.2, 0.4, 0.6, 0.8]);
    assert.deepEqual(niceTicks(-30, 50, 4), [-40, -20, 0, 20, 40, 60]);
    assert.deepEqual(niceTicks(0, 3, 5, true), [0, 1, 2, 3]);
    assert.deepEqual(niceTicks(0, 10, 4, true), [0, 2, 4, 6, 8, 10]); // 2.5 isn't whole
    assert.deepEqual(niceTicks(5, 5, 5), [0, 1, 2, 3, 4, 5]); // one value: from zero
    assert.deepEqual(niceTicks(0, 0), [0, 0.2, 0.4, 0.6, 0.8, 1]);
    assert.deepEqual(niceTicks(0, 12_400, 4), [0, 5000, 10000, 15000]);
  });
});

describe('Checking a chart', () => {
  it('keeps the table as text, trimmed, with numbers sent as numbers', () => {
    const chart = chartContent(TWO);
    assert.deepEqual(chart.rows[0], ['Mon', '14', '6']);
    assert.equal(chart.kind, 'line');
    assert.equal(chart.unit, 'tasks');
    const model = chartModel(chart);
    assert.deepEqual(model.series.map((s) => s.name), ['Opened', 'Done']);
    assert.deepEqual(model.series[1].values, [6, 18, 34, 49, 58]);
  });

  it('refuses what it cannot draw, saying what to change', () => {
    refuses({ ...WEEK, rows: [...WEEK.rows, ['Sat', 'n/a']] }, /^"n\/a" in Done for "Sat" isn't a number\. Series cells are numbers, such as 1,234 or 12%; leave a cell empty for a gap/);
    refuses({ ...WEEK, rows: [['Mon', 'lots'], ['Tue', 'more']] }, /"lots" in Done for "Mon" isn't a number \(and 1 more cell\)/);
    const nine = ['Team', ...Array.from({ length: 9 }, (_, i) => `S${i + 1}`)];
    refuses({ kind: 'bar', columns: nine, rows: [nine.map((_, i) => (i ? '1' : 'A'))] }, /at most 8 series, and this one has 9\. Fold the smallest into an "Other" column, or make two charts/);
    refuses({ ...TWO, kind: 'pie' }, /A pie shows one series, the parts of a single whole, and this one has 2 \("Opened" and "Done"\)\. Use stacked-bar/);
    refuses({ kind: 'pie', columns: ['Team', 'Cost'], rows: [['A', '5'], ['Refunds', '-2']] }, /A pie's parts can't be negative: "Refunds" is -2\. Use a bar chart/);
    refuses({ kind: 'pie', columns: ['Team', 'Cost'], rows: Array.from({ length: 9 }, (_, i) => [`T${i}`, '1']) }, /A pie shows at most 8 parts, and this one has 9\. Fold the smallest into "Other"/);
    refuses({ ...TWO, kind: 'stacked-bar', rows: [['Mon', '3', '-1']] }, /A stacked bar's parts can't be negative: Done for "Mon" is -1/);
    refuses({ ...WEEK, rows: Array.from({ length: 201 }, (_, i) => [`D${i}`, '1']) }, /at most about 200 categories, and this one has 201 rows\. Group them/);
    refuses({ ...WEEK, kind: 'scatter' }, /"scatter" isn't a kind of chart: use bar, line, area, stacked-bar or pie\./);
    refuses({ ...WEEK, columns: ['Day'], rows: [['Mon']] }, /needs a first column of categories .* and at least one column of numbers/);
    refuses({ ...TWO, columns: ['Day', 'Done', 'done'] }, /Two columns are named "done": name each series differently\./);
    refuses({ ...WEEK, rows: [] }, /at least one row of data/);
    refuses({ ...WEEK, rows: [['Mon', ''], ['Tue', '']] }, /at least one number: every series cell is empty/);
    refuses({ ...WEEK, highlight: 'Sat' }, /highlight "Sat" isn't one of the chart's categories \(its first column\): "Mon", "Tue"/);
  });

  it('keeps a highlight that is a category, and drops one carried over whose category is gone', () => {
    assert.equal(chartContent({ ...WEEK, highlight: 'thu' }).highlight, 'Thu');
    assert.equal(chartContent({ ...WEEK, highlight: 'Sat' }, { highlight: false }).highlight, undefined);
    assert.equal(chartContent({ ...WEEK, rows: [['Mon', ''], ['Tue', '4']] }).rows[0][1], ''); // a gap
  });

  it('makes a bar chart of a table: its first column and its columns of numbers', () => {
    const { content, left } = chartFromTable(
      ['Service', 'p50', 'Notes', 'p95'],
      [
        ['Search', '120', 'fine', '340'],
        ['Payments', '80', '', '1,200'],
      ],
    );
    assert.equal(content.kind, 'bar');
    assert.deepEqual(content.columns, ['Service', 'p50', 'p95']);
    assert.deepEqual(content.rows, [
      ['Search', '120', '340'],
      ['Payments', '80', '1,200'],
    ]);
    assert.deepEqual(left, ['Notes']);
    assert.equal(chartFromTable(['Team', 'Share'], [['A', '40%'], ['B', '60%']]).content.unit, '%');
    assert.throws(() => chartFromTable(['Option', 'Pros'], [['A', 'fast']]), /no column of numbers to chart/);
  });
});

describe('Laying out a chart', () => {
  it('draws thin bars from the baseline with rounded data ends, a bigger hit target, and the peak labelled', () => {
    const model = chartModel(chartContent(WEEK));
    const layout = chartLayout(model, { width: 450, height: 250 });
    assert.equal(layout.bars.length, 5);
    for (const bar of layout.bars) {
      assert.ok(bar.w <= 24, 'bars are at most 24px');
      assert.ok(Math.abs(bar.y + bar.h - layout.zero) < 0.01, 'bars grow from the baseline');
      assert.match(bar.path, /A4 4 0 0 1/, 'a 4px rounded data end');
      assert.ok(bar.hit.w > bar.w && bar.hit.h > bar.h, 'the hit target is bigger than the mark');
    }
    assert.deepEqual(layout.ticks.map((t) => t.label), ['0', '5', '10', '15']); // 16 rises over the 15 line, as in the mock
    assert.equal(layout.caption?.text, 'tasks'); // a word unit: once, over the axis
    assert.deepEqual(layout.labels.map((l) => l.text), ['16']); // the peak only
    const thu = layout.bars[3];
    assert.equal(layout.labels[0].x, thu.x + thu.w / 2);
    assert.deepEqual(layout.axis.map((a) => a.text), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

    const highlighted = chartLayout(chartModel(chartContent({ ...WEEK, highlight: 'Tue' })), { width: 450, height: 250 });
    assert.deepEqual(highlighted.labels.map((l) => l.text), ['8']); // the highlighted category instead
  });

  it('leaves a 2px surface gap between adjacent bars and between stacked segments; only the top segment is rounded', () => {
    const grouped = chartLayout(chartModel(chartContent({ ...TWO, kind: 'bar' })), { width: 480, height: 260 });
    const [a, b] = grouped.bars.filter((bar) => bar.category === 2);
    assert.ok(Math.abs(b.x - (a.x + a.w) - 2) < 0.01);
    assert.ok(a.hit.w >= a.w + 2);

    const stacked = chartLayout(chartModel(chartContent({ ...TWO, kind: 'stacked-bar' })), { width: 480, height: 260 });
    const [low, high] = stacked.bars.filter((bar) => bar.category === 4);
    assert.ok(Math.abs(high.y + high.h + 2 - low.y) < 0.01, 'the segment above sits 2px over the one below');
    assert.doesNotMatch(low.path, /A/);
    assert.match(high.path, /A4 4 0 0 1/);
    assert.deepEqual(stacked.labels.map((l) => l.text), ['119']); // the tallest stack's total
  });

  it('draws lines with labels at their ends, spread apart with leaders where the lines meet', () => {
    const layout = chartLayout(chartModel(chartContent(TWO)), { width: 470, height: 250 });
    assert.equal(layout.lines.length, 2);
    assert.match(layout.lines[0].path, /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+){4}$/);
    const ends = layout.labels.filter((l) => l.anchor === 'start');
    assert.deepEqual(ends.map((l) => l.text).sort(), ['Done 58', 'Opened 61']);
    assert.ok(Math.abs(ends[0].y - ends[1].y) >= 13, 'end labels do not collide');
    assert.ok(ends.some((l) => l.leader), 'a moved label has a leader to its line');
    assert.equal(layout.markers.length, 2); // a dot on each labelled end
    // The hover columns cover the plot, edge to edge.
    assert.equal(layout.bands[0].x, layout.plot.x);
    assert.ok(Math.abs(layout.bands.at(-1)!.x + layout.bands.at(-1)!.w - (layout.plot.x + layout.plot.w)) < 0.01);

    // A gap breaks the line; a point alone between gaps is a dot.
    const gappy = chartLayout(chartModel(chartContent({ ...WEEK, kind: 'line', rows: [['Mon', '3'], ['Tue', ''], ['Wed', '5'], ['Thu', ''], ['Fri', '7'], ['Sat', '9']] })), { width: 400, height: 240 });
    assert.equal(gappy.lines[0].lone.length, 2);
    assert.equal(gappy.lines[0].path.match(/M/g)?.length, 1);
  });

  it('thins and fits category labels so they never overlap', () => {
    const rows = Array.from({ length: 60 }, (_, i) => [`2026-09-${String((i % 30) + 1).padStart(2, '0')}`, String(i)]);
    const layout = chartLayout(chartModel(chartContent({ kind: 'line', columns: ['Day', 'Signups'], rows })), { width: 320, height: 200 });
    assert.ok(layout.axis.length < 60 && layout.axis.length > 1);
    const spans = layout.axis.map((a) => {
      const w = textWidth(a.text);
      const from = a.anchor === 'start' ? a.x : a.anchor === 'end' ? a.x - w : a.x - w / 2;
      return [from, from + w];
    });
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] > spans[i - 1][1], `labels ${i - 1} and ${i} overlap`);
    for (const [from, to] of spans) assert.ok(from >= 0 && to <= 320, 'labels stay inside the chart');
  });

  it('draws a pie as a ring of parts with its total, and labels the biggest share', () => {
    const pie = chartContent({ kind: 'pie', columns: ['Status', 'Tasks'], rows: [['Done', '58'], ['In progress', '9'], ['To do', '21'], ['Blocked', '', ]] });
    const layout = chartLayout(chartModel(pie), { width: 400, height: 240 });
    assert.equal(layout.slices.length, 3); // the gap has no slice
    assert.ok(Math.abs(layout.slices.reduce((sum, s) => sum + s.share, 0) - 1) < 1e-9);
    assert.equal(layout.ring?.total, '88');
    assert.deepEqual(layout.labels.map((l) => l.text), ['66%']);
  });

  it('draws nothing it cannot fit', () => {
    const layout = chartLayout(chartModel(chartContent(WEEK)), { width: 60, height: 40 });
    assert.equal(layout.bars.length, 0);
  });
});

describe('Charts for agents and pins', () => {
  it('describes a chart compactly, and in full with its table', () => {
    const chart = chartContent({ ...TWO, subtitle: 'Running total', highlight: 'Thu' });
    assert.equal(
      chartDigest(chart),
      [
        'line chart · 5 categories, Mon to Fri · in tasks · highlight "Thu"',
        'Subtitle: Running total',
        'Opened: 14 tasks (Mon) to 61 tasks (Fri)',
        'Done: 6 tasks (Mon) to 58 tasks (Fri)',
        '(get_block for the table)',
      ].join('\n'),
    );
    const full = chartDigest(chart, true);
    assert.match(full, /\| Day \| Opened \| Done \|\n\| --- \| --- \| --- \|\n\| Mon \| 14 \| 6 \|/);
    assert.doesNotMatch(full, /get_block/);
  });

  it('finds a pinned point again by its category and series names, and quotes it', () => {
    const chart: ChartContent = chartContent(TWO);
    assert.deepEqual(findPoint(chart, 'Thu', 'Done'), { row: 3, series: 1 });
    assert.deepEqual(findPoint(chart, 'thu'), { row: 3, series: null });
    assert.equal(findPoint(chart, 'Sat'), null);
    assert.equal(findPoint(chart, 'Thu', 'Closed'), null);
    assert.equal(pointQuote(chart, 3, 1), 'Thu · Done: 49 tasks');
    assert.equal(pointQuote(chart, 3, null), 'Thu');
    assert.equal(pointQuote(chartContent(WEEK), 3, null), 'Thu: 16 tasks');
  });

  it('says what changed in a chart', () => {
    const before = chartContent(WEEK);
    const after = chartContent({ ...WEEK, kind: 'line', rows: [...WEEK.rows.slice(0, 4), ['Fri', '15']], highlight: 'Fri' });
    assert.deepEqual(describeChartChange(before, after), ['made it a line chart', 'highlighted "Fri"', 'set Done for "Fri" to "15"']);
  });
});

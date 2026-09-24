/**
 * Shared chart theme (Part 16). Restrained palette: brand #D1990A is the primary
 * accent; supporting series use muted neutral/info tones. Kept in sync with the
 * design tokens so charts never introduce ad-hoc colors.
 */
export const CHART = {
  primary: '#d1990a',
  info: '#1f6fb2',
  success: '#12854e',
  danger: '#c0392b',
  neutral: '#98a2b3',
  grid: '#e5e7eb',
  axis: '#98a2b3',
};

export const chartAxisProps = {
  stroke: CHART.axis,
  fontSize: 11,
  tickLine: false,
  axisLine: { stroke: CHART.grid },
};

export const chartTooltipStyle = {
  background: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  fontSize: 12,
  boxShadow: '0 4px 12px rgba(16,24,40,0.08)',
};

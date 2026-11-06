/**
 * Shared chart theme (Part 16, theme-aware since DPI 2 item 10). Values are CSS custom properties (--chart-*,
 * defined in styles.css, branding/brand.css and theme/theme.css), so recharts re-colours when the theme changes
 * with no re-render logic. Never put raw hex colours here.
 */
export const CHART = {
  primary: 'var(--chart-primary)',
  info: 'var(--chart-info)',
  success: 'var(--chart-success)',
  danger: 'var(--chart-danger)',
  neutral: 'var(--chart-neutral)',
  grid: 'var(--chart-grid)',
  axis: 'var(--chart-axis)',
};
export const chartAxisProps = {
  stroke: CHART.axis,
  fontSize: 11,
  tickLine: false,
  axisLine: { stroke: CHART.grid },
};
export const chartTooltipStyle = {
  background: 'var(--chart-tooltip-bg)',
  color: 'var(--chart-tooltip-text)',
  border: '1px solid var(--chart-tooltip-border)',
  borderRadius: 8,
  fontSize: 12,
  boxShadow: 'var(--shadow-md)',
};
import React from 'react';
import { PipelineStats } from '../types';

const StatCard: React.FC<{ label: string; value: string | number; color: string; sub?: string }> = ({ label, value, color, sub }) => (
  <div style={{
    background: '#161b22',
    border: '1px solid #21262d',
    borderRadius: 8,
    padding: 20,
    flex: 1,
    minWidth: 160,
  }}>
    <div style={{ fontSize: 12, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
    <div style={{ fontSize: 28, fontWeight: 700, color, marginTop: 4 }}>{value}</div>
    {sub && <div style={{ fontSize: 12, color: '#8b949e', marginTop: 4 }}>{sub}</div>}
  </div>
);

const StatsCards: React.FC<{ stats: PipelineStats }> = ({ stats }) => (
  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
    <StatCard label="Total Processed" value={stats.total.toLocaleString()} color="#f0f6fc" />
    <StatCard label="Complete" value={stats.complete.toLocaleString()} color="#3fb950" sub={`${stats.straightThroughRate.toFixed(1)}% straight-through`} />
    <StatCard label="In Processing" value={stats.processing} color="#58a6ff" />
    <StatCard label="HITL Queue" value={stats.hitlReview} color="#d29922" />
    <StatCard label="Fraud Review" value={stats.fraudReview} color="#f85149" />
    <StatCard label="Rejected" value={stats.rejected} color="#8b949e" />
    <StatCard label="Avg Confidence" value={`${(stats.avgConfidence * 100).toFixed(1)}%`} color="#a5d6ff" />
    <StatCard label="Avg Time" value={`${stats.avgProcessingTime.toFixed(1)}s`} color="#a5d6ff" sub={`${stats.throughputPerHour.toFixed(0)} docs/hr`} />
  </div>
);

export default StatsCards;

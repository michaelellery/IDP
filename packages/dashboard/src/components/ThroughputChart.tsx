import React from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { TimeSeriesPoint } from '../types';

const ThroughputChart: React.FC<{ data: TimeSeriesPoint[] }> = ({ data }) => (
  <div style={{
    background: '#161b22',
    border: '1px solid #21262d',
    borderRadius: 8,
    padding: 20,
  }}>
    <h3 style={{ fontSize: 14, color: '#8b949e', marginBottom: 16 }}>Processing Throughput (24h)</h3>
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#58a6ff" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#58a6ff" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
        <XAxis dataKey="timestamp" stroke="#484f58" fontSize={11} />
        <YAxis stroke="#484f58" fontSize={11} />
        <Tooltip
          contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6 }}
          labelStyle={{ color: '#8b949e' }}
        />
        <Area type="monotone" dataKey="count" stroke="#58a6ff" fill="url(#colorCount)" />
      </AreaChart>
    </ResponsiveContainer>
  </div>
);

export default ThroughputChart;

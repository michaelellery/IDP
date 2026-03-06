import React, { useState, useEffect, useCallback } from 'react';
import { PipelineStats, DocumentRecord, TimeSeriesPoint } from './types';
import StatsCards from './components/StatsCards';
import ThroughputChart from './components/ThroughputChart';
import DocumentTable from './components/DocumentTable';
import DocumentViewer from './components/DocumentViewer';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const App: React.FC = () => {
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [timeSeries, setTimeSeries] = useState<TimeSeriesPoint[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, docsRes, tsRes] = await Promise.all([
        fetch(`${API_BASE}/stats`),
        fetch(`${API_BASE}/documents?status=${filter}&limit=50`),
        fetch(`${API_BASE}/timeseries?hours=24`),
      ]);
      setStats(await statsRes.json());
      setDocuments(await docsRes.json());
      setTimeSeries(await tsRes.json());
    } catch (err) {
      console.error('Failed to fetch data:', err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <div style={{ minHeight: '100vh', background: '#0f1117' }}>
      {/* Header */}
      <header style={{
        padding: '16px 24px',
        borderBottom: '1px solid #21262d',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 24 }}>📄</span>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: '#f0f6fc' }}>IDP Pipeline Dashboard</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {['all', 'PROCESSING', 'COMPLETE', 'REJECTED', 'HITL_REVIEW', 'FRAUD_REVIEW'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: filter === f ? '1px solid #58a6ff' : '1px solid #30363d',
                background: filter === f ? '#1f6feb22' : 'transparent',
                color: filter === f ? '#58a6ff' : '#8b949e',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              {f === 'all' ? 'All' : f.replace('_', ' ')}
            </button>
          ))}
        </div>
      </header>

      <main style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
        {/* Stats Cards */}
        {stats && <StatsCards stats={stats} />}

        {/* Throughput Chart */}
        <div style={{ marginTop: 24 }}>
          <ThroughputChart data={timeSeries} />
        </div>

        {/* Document Table + Viewer */}
        <div style={{ marginTop: 24, display: 'grid', gridTemplateColumns: selectedDoc ? '1fr 1fr' : '1fr', gap: 24 }}>
          <DocumentTable
            documents={documents}
            onSelect={setSelectedDoc}
            selectedId={selectedDoc?.document_name}
          />
          {selectedDoc && (
            <DocumentViewer
              document={selectedDoc}
              onClose={() => setSelectedDoc(null)}
            />
          )}
        </div>
      </main>
    </div>
  );
};

export default App;

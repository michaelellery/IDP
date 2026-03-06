import React from 'react';
import { DocumentRecord } from '../types';

const statusColors: Record<string, string> = {
  PROCESSING: '#58a6ff',
  EXTRACTED: '#a371f7',
  COMPLETE: '#3fb950',
  REJECTED: '#8b949e',
  HITL_REVIEW: '#d29922',
  FRAUD_REVIEW: '#f85149',
};

const DocumentTable: React.FC<{
  documents: DocumentRecord[];
  onSelect: (doc: DocumentRecord) => void;
  selectedId?: string;
}> = ({ documents, onSelect, selectedId }) => (
  <div style={{
    background: '#161b22',
    border: '1px solid #21262d',
    borderRadius: 8,
    overflow: 'hidden',
  }}>
    <div style={{ padding: '12px 16px', borderBottom: '1px solid #21262d' }}>
      <h3 style={{ fontSize: 14, color: '#8b949e' }}>Documents ({documents.length})</h3>
    </div>
    <div style={{ maxHeight: 600, overflowY: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #21262d' }}>
            <th style={{ padding: '8px 12px', textAlign: 'left', color: '#8b949e', fontWeight: 500 }}>Document ID</th>
            <th style={{ padding: '8px 12px', textAlign: 'left', color: '#8b949e', fontWeight: 500 }}>Type</th>
            <th style={{ padding: '8px 12px', textAlign: 'left', color: '#8b949e', fontWeight: 500 }}>Status</th>
            <th style={{ padding: '8px 12px', textAlign: 'right', color: '#8b949e', fontWeight: 500 }}>Confidence</th>
            <th style={{ padding: '8px 12px', textAlign: 'right', color: '#8b949e', fontWeight: 500 }}>Time</th>
          </tr>
        </thead>
        <tbody>
          {documents.map(doc => (
            <tr
              key={doc.document_name}
              onClick={() => onSelect(doc)}
              style={{
                cursor: 'pointer',
                borderBottom: '1px solid #21262d',
                background: selectedId === doc.document_name ? '#1f6feb22' : 'transparent',
              }}
              onMouseEnter={e => { if (selectedId !== doc.document_name) e.currentTarget.style.background = '#161b2280'; }}
              onMouseLeave={e => { if (selectedId !== doc.document_name) e.currentTarget.style.background = 'transparent'; }}
            >
              <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 12 }}>
                {doc.document_name.slice(0, 8)}...
              </td>
              <td style={{ padding: '10px 12px' }}>{doc.document_type}</td>
              <td style={{ padding: '10px 12px' }}>
                <span style={{
                  padding: '2px 8px',
                  borderRadius: 12,
                  fontSize: 11,
                  fontWeight: 600,
                  color: statusColors[doc.status] || '#8b949e',
                  background: `${statusColors[doc.status] || '#8b949e'}22`,
                }}>
                  {doc.status}
                </span>
              </td>
              <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                {doc.confidence ? `${(doc.confidence * 100).toFixed(1)}%` : '—'}
              </td>
              <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#8b949e' }}>
                {doc.processing_time ? `${doc.processing_time.toFixed(1)}s` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

export default DocumentTable;

import React, { useState } from 'react';
import { DocumentRecord } from '../types';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const DocumentViewer: React.FC<{
  document: DocumentRecord;
  onClose: () => void;
}> = ({ document: doc, onClose }) => {
  const [tab, setTab] = useState<'preview' | 'data' | 'metadata'>('preview');

  const pdfUrl = `${API_BASE}/documents/${doc.document_name}/pdf`;

  return (
    <div style={{
      background: '#161b22',
      border: '1px solid #21262d',
      borderRadius: 8,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      maxHeight: 700,
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #21262d',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <h3 style={{ fontSize: 14, color: '#f0f6fc' }}>Document Viewer</h3>
          <span style={{ fontSize: 11, color: '#8b949e', fontFamily: 'monospace' }}>{doc.document_name}</span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 18,
          }}
        >✕</button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #21262d' }}>
        {(['preview', 'data', 'metadata'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 16px',
              background: 'none',
              border: 'none',
              borderBottom: tab === t ? '2px solid #58a6ff' : '2px solid transparent',
              color: tab === t ? '#f0f6fc' : '#8b949e',
              cursor: 'pointer',
              fontSize: 13,
              textTransform: 'capitalize',
            }}
          >{t === 'data' ? 'Extracted Data' : t}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: tab === 'preview' ? 0 : 16 }}>
        {tab === 'preview' && (
          <iframe
            src={pdfUrl}
            style={{ width: '100%', height: 500, border: 'none', background: '#fff' }}
            title="Document Preview"
          />
        )}

        {tab === 'data' && (
          <div>
            <h4 style={{ fontSize: 13, color: '#8b949e', marginBottom: 12 }}>
              Extracted Fields — {doc.document_type}
            </h4>
            {doc.extraction_data ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ padding: '6px 8px', textAlign: 'left', color: '#8b949e', borderBottom: '1px solid #21262d' }}>Field</th>
                    <th style={{ padding: '6px 8px', textAlign: 'left', color: '#8b949e', borderBottom: '1px solid #21262d' }}>Value</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right', color: '#8b949e', borderBottom: '1px solid #21262d' }}>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(doc.extraction_data).map(([key, val]: [string, any]) => (
                    <tr key={key} style={{ borderBottom: '1px solid #21262d' }}>
                      <td style={{ padding: '6px 8px', color: '#a5d6ff' }}>{key}</td>
                      <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 12 }}>
                        {typeof val === 'object' ? val.value : val}
                      </td>
                      <td style={{
                        padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12,
                        color: (val?.confidence || 0) > 0.9 ? '#3fb950' : (val?.confidence || 0) > 0.8 ? '#d29922' : '#f85149',
                      }}>
                        {val?.confidence ? `${(val.confidence * 100).toFixed(0)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ color: '#8b949e' }}>No extraction data available yet.</p>
            )}
          </div>
        )}

        {tab === 'metadata' && (
          <div style={{ fontSize: 13 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {[
                  ['Document ID', doc.document_name],
                  ['Matter ID', doc.matter_id],
                  ['Document Type', doc.document_type],
                  ['Status', doc.status],
                  ['Confidence', doc.confidence ? `${(doc.confidence * 100).toFixed(1)}%` : '—'],
                  ['S3 Key', doc.s3_key],
                  ['Source Channel', doc.source_channel],
                  ['Processing Time', doc.processing_time ? `${doc.processing_time.toFixed(2)}s` : '—'],
                  ['Quality Score', doc.quality_score ? `${(doc.quality_score * 100).toFixed(1)}%` : '—'],
                  ['Fraud Flagged', doc.fraud_flagged ? '⚠️ YES' : '✅ No'],
                  ['Created', new Date(doc.created_at).toLocaleString()],
                  ['Updated', new Date(doc.updated_at).toLocaleString()],
                ].map(([label, value]) => (
                  <tr key={label} style={{ borderBottom: '1px solid #21262d' }}>
                    <td style={{ padding: '8px', color: '#8b949e', width: 140 }}>{label}</td>
                    <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: 12 }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default DocumentViewer;

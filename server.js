require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const os = require('os');

const app = express();
app.use(express.json());
app.use(cors());

// ========================================
// 서버 식별자 (로드밸런싱 확인용)
// ========================================
const SERVER_ID = os.hostname();
const SERVER_IP = Object.values(os.networkInterfaces())
  .flat()
  .filter(iface => iface.family === 'IPv4' && !iface.internal)
  .map(iface => iface.address)[0] || 'unknown';

console.log(`Server starting: ${SERVER_ID} (${SERVER_IP})`);

// ========================================
// DB 연결 풀
// ========================================
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// DB 연결 테스트
pool.getConnection()
  .then(conn => {
    console.log('DB connected successfully');
    conn.release();
  })
  .catch(err => {
    console.error('DB connection failed:', err.message);
  });

// ========================================
// 라우트
// ========================================

// 헬스체크 (ALB용)
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    server: SERVER_ID,
    ip: SERVER_IP,
    timestamp: new Date().toISOString(),
  });
});

// DB 헬스체크
app.get('/api/health/db', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', server: SERVER_ID });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', message: err.message });
  }
});

// 메시지 목록 조회
app.get('/api/messages', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, content, created_at FROM messages ORDER BY created_at DESC LIMIT 50'
    );
    res.json({
      server: SERVER_ID,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error('GET /api/messages error:', err);
    res.status(500).json({ error: err.message, server: SERVER_ID });
  }
});

// 메시지 추가
app.post('/api/messages', async (req, res) => {
  const { name, content } = req.body;

  if (!name || !content) {
    return res.status(400).json({
      error: 'name and content are required',
      server: SERVER_ID,
    });
  }

  try {
    const [result] = await pool.query(
      'INSERT INTO messages (name, content) VALUES (?, ?)',
      [name, content]
    );
    res.status(201).json({
      server: SERVER_ID,
      id: result.insertId,
      message: 'created',
    });
  } catch (err) {
    console.error('POST /api/messages error:', err);
    res.status(500).json({ error: err.message, server: SERVER_ID });
  }
});

// 메시지 삭제
app.delete('/api/messages/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await pool.query('DELETE FROM messages WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: 'not found',
        server: SERVER_ID,
      });
    }

    res.json({
      server: SERVER_ID,
      message: 'deleted',
    });
  } catch (err) {
    console.error('DELETE /api/messages/:id error:', err);
    res.status(500).json({ error: err.message, server: SERVER_ID });
  }
});

// 404 핸들러
app.use((req, res) => {
  res.status(404).json({ error: 'not found', server: SERVER_ID });
});

// ========================================
// 서버 시작
// ========================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server ${SERVER_ID} running on port ${PORT}`);
});

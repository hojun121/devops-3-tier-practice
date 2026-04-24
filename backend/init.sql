-- ========================================
-- Database 초기화 SQL
-- Bastion에서 RDS 접속 후 실행
-- ========================================

CREATE DATABASE IF NOT EXISTS guestbook
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE guestbook;

-- messages 테이블
CREATE TABLE IF NOT EXISTS messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 초기 샘플 데이터 (선택사항)
INSERT INTO messages (name, content) VALUES
  ('관리자', '환영합니다! AWS 3-Tier 아키텍처 실습에 오신 것을 환영합니다.'),
  ('테스터', '메시지를 작성하면 DB에 저장됩니다.');

-- 확인
SELECT * FROM messages;

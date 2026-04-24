// ========================================
// API 엔드포인트 설정
// ========================================
// 상황별로 바꿔서 사용:
//
// 1. ALB 직접 테스트 (CloudFront 전):
//    const API_BASE = 'http://my-alb-xxxxx.ap-northeast-2.elb.amazonaws.com/api';
//
// 2. CloudFront 통해서 (실습 최종):
//    const API_BASE = '/api';
//
// ========================================
const API_BASE = '/api';

// ========================================
// DOM 요소
// ========================================
const serverIdEl = document.getElementById('server-id');
const messagesEl = document.getElementById('messages');
const countEl = document.getElementById('count');
const formEl = document.getElementById('messageForm');
const refreshBtn = document.getElementById('refreshBtn');

// ========================================
// API 호출 함수
// ========================================

async function loadMessages() {
  try {
    const res = await fetch(`${API_BASE}/messages`);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const result = await res.json();

    // 서버 ID 표시
    serverIdEl.textContent = result.server;
    serverIdEl.classList.add('highlight');
    setTimeout(() => serverIdEl.classList.remove('highlight'), 500);

    // 메시지 목록 렌더링
    countEl.textContent = result.count;

    if (result.data.length === 0) {
      messagesEl.innerHTML = '<p class="empty">아직 메시지가 없습니다. 첫 메시지를 남겨보세요!</p>';
      return;
    }

    messagesEl.innerHTML = result.data
      .map(
        m => `
        <div class="message">
          <div class="message-header">
            <strong>${escapeHtml(m.name)}</strong>
            <button class="delete-btn" data-id="${m.id}">삭제</button>
          </div>
          <p class="message-content">${escapeHtml(m.content)}</p>
          <small class="message-time">${formatTime(m.created_at)}</small>
        </div>
      `
      )
      .join('');

    // 삭제 버튼 이벤트
    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteMessage(btn.dataset.id));
    });
  } catch (err) {
    console.error('loadMessages error:', err);
    serverIdEl.textContent = '연결 실패';
    messagesEl.innerHTML = `<p class="error">서버 연결 실패: ${err.message}</p>`;
  }
}

async function createMessage(name, content) {
  const res = await fetch(`${API_BASE}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return res.json();
}

async function deleteMessage(id) {
  if (!confirm('정말 삭제하시겠습니까?')) return;

  try {
    const res = await fetch(`${API_BASE}/messages/${id}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    await loadMessages();
  } catch (err) {
    alert(`삭제 실패: ${err.message}`);
  }
}

// ========================================
// 유틸
// ========================================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ========================================
// 이벤트 리스너
// ========================================

formEl.addEventListener('submit', async e => {
  e.preventDefault();

  const name = document.getElementById('name').value.trim();
  const content = document.getElementById('content').value.trim();

  if (!name || !content) return;

  try {
    await createMessage(name, content);
    formEl.reset();
    await loadMessages();
  } catch (err) {
    alert(`작성 실패: ${err.message}`);
  }
});

refreshBtn.addEventListener('click', loadMessages);

// ========================================
// 초기 로드 + 자동 새로고침
// ========================================

loadMessages();

// 5초마다 새로고침 (로드밸런싱 동작 확인용)
setInterval(loadMessages, 5000);

// worker_mock.js
// ItplayLab JobQueue Worker (Render용, fetch + ffmpeg 스모크 테스트)

const JOBQUEUE_WEBAPP_URL = process.env.JOBQUEUE_WEBAPP_URL;
const POLL_INTERVAL_MS = 5000; // 5초마다 폴링

// ffmpeg (옵셔널: ffmpeg-static 있으면 사용, 없으면 전역 ffmpeg)
const { spawn } = require('child_process');

let ffmpegPath;

try {
  ffmpegPath = require('ffmpeg-static');
  console.log('[WORKER] 🎬 ffmpeg-static 모듈 로드됨:', ffmpegPath);
} catch (e) {
  console.warn('[WORKER] ⚠ ffmpeg-static 모듈을 찾지 못했습니다. 전역 ffmpeg 바이너리를 시도합니다.');
  ffmpegPath = 'ffmpeg'; // PATH에 있는 ffmpeg 사용 시도
}


if (!JOBQUEUE_WEBAPP_URL) {
  console.error('[WORKER] ❌ 환경변수 JOBQUEUE_WEBAPP_URL 이 설정되지 않았습니다.');
  process.exit(1);
}

console.log('[WORKER] ✅ Worker 시작됨');
console.log(`[WORKER] JobQueue URL: ${JOBQUEUE_WEBAPP_URL}`);
console.log(`[WORKER] Poll interval: ${POLL_INTERVAL_MS}ms`);

let isProcessing = false;

// ____________________________
// 메인 폴링 루프
// ____________________________

async function pollOnce() {
  console.log(`\n[WORKER] 🔄 next-job 요청 (${new Date().toISOString()})`);

  let resJson;
  try {
    const res = await fetch(JOBQUEUE_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route: 'next-job' }),
    });

    resJson = await res.json();
  } catch (err) {
    console.error('[WORKER] ❌ next-job 호출 실패:', err.message || err);
    return;
  }

  const data = resJson || {};
  const ok = data.ok;
  const job = data.job;

  if (!ok) {
    console.warn('[WORKER] ⚠️ next-job 응답 ok:false', data);
    return;
  }

  if (!job) {
    console.log('[WORKER] 📭 PENDING job 없음 (대기)');
    return;
  }

  console.log(`[WORKER] 📦 Job 할당됨: id=${job.id}, status=${job.status}`);

  try {
    await processJob(job);                 // 실제 작업(ffmpeg 테스트)
    await updateJobStatus(job.id, 'DONE'); // 완료 처리
    console.log(`[WORKER] ✅ Job 완료 처리: id=${job.id}, status=DONE`);
  } catch (err) {
    console.error(`[WORKER] ❌ Job 처리 실패: id=${job.id}`);
    console.error('  error:', err.message || err);

    try {
      await updateJobStatus(job.id, 'FAILED');
      console.log(`[WORKER] ⚠️ Job 상태를 FAILED 로 저장: id=${job.id}`);
    } catch (e2) {
      console.error('[WORKER] ❌ FAILED 상태 업데이트도 실패', e2.message || e2);
    }
  }
}

// interval마다 돌리되, 이전 작업이 끝나지 않았으면 skip
async function pollLoop() {
  if (isProcessing) {
    console.log('[WORKER] ⏸ 이전 Job 처리 중, 이번 턴은 건너뜀');
    return;
  }

  isProcessing = true;
  try {
    await pollOnce();
  } finally {
    isProcessing = false;
  }
}

setInterval(pollLoop, POLL_INTERVAL_MS);
console.log('[WORKER] 🚀 Polling loop started');

// ____________________________
// 실제 작업 로직 (ffmpeg 스모크 테스트)
// ____________________________

async function processJob(job) {
  console.log(`[WORKER] 🛠 Job 처리 시작: id=${job.id}`);

  if (!ffmpegPath) {
    console.warn('[WORKER] ⚠ ffmpeg-static 경로를 찾지 못했습니다.');
    await sleep(1000);
    return;
  }

  console.log(`[WORKER] ▶ ffmpeg 버전 확인 (binary: ${ffmpegPath})`);

  await runFfmpegVersion();

  console.log(`[WORKER] ✅ ffmpeg 버전 확인 완료: id=${job.id}`);
}

// ____________________________
// Job 상태 업데이트 API 호출
// ____________________________

async function updateJobStatus(id, status) {
  const payload = {
    route: 'update-job-status',
    id,
    status,
  };

  let resJson;
  try {
    const res = await fetch(JOBQUEUE_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    resJson = await res.json();
  } catch (err) {
    throw new Error('update-job-status 호출 실패: ' + (err.message || err));
  }

  const data = resJson || {};
  if (!data.ok) {
    throw new Error('update-job-status 응답 ok:false: ' + JSON.stringify(data));
  }
}

// ____________________________
// ffmpeg 유틸
// ____________________________

function runFfmpegVersion() {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-version']);

    let output = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        const firstLine = output.split('\n')[0];
        console.log('[WORKER] ffmpeg -version 출력 (첫 줄):', firstLine);
        resolve();
      } else {
        reject(new Error(`ffmpeg 종료 코드 ${code}\n${output}`));
      }
    });
  });
}

// ____________________________
// 유틸
// ____________________________

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

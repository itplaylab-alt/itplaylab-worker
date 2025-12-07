// worker_mock.js
// ItplayLab JobQueue Worker (Render용, /next-job 폴링 + ffmpeg 스모크 테스트)

// 1) 기본 설정 & 환경변수
// --------------------------------------------------

const JOBQUEUE_WEBAPP_URL = process.env.JOBQUEUE_WEBAPP_URL;
const JOBQUEUE_WORKER_SECRET = process.env.JOBQUEUE_WORKER_SECRET || "";
const POLL_INTERVAL_MS = 5000; // 5초마다 폴링
const WORKER_ID = process.env.WORKER_ID || "itplaylab-worker-1";

console.log(
  "[WORKER] DEBUG WORKER_ID env:",
  process.env.WORKER_ID,
  "local:",
  WORKER_ID
);

if (!JOBQUEUE_WEBAPP_URL) {
  console.error(
    "[WORKER] ❌ 환경변수 JOBQUEUE_WEBAPP_URL 이 설정되지 않았습니다."
  );
  process.exit(1);
}

// BASE URL: /next-job 뒤를 잘라내서 서버 베이스 URL 만들기
const BASE_URL = JOBQUEUE_WEBAPP_URL.replace(/\/next-job.*$/i, "");

// 완료 상태 업데이트 URL (/update-job-status)
const JOB_STATUS_URL = `${BASE_URL}/update-job-status`;

// Worker 전용 /next-job URL (secret 포함)
const NEXT_JOB_URL = `${BASE_URL}/next-job?secret=${encodeURIComponent(
  JOBQUEUE_WORKER_SECRET || ""
)}`;

if (!JOBQUEUE_WORKER_SECRET) {
  console.warn(
    "[WORKER] ⚠ JOBQUEUE_WORKER_SECRET 이 비어있습니다. 서버에서 인증을 건다면 꼭 설정해야 합니다."
  );
}

// ffmpeg (옵셔널: ffmpeg-static 있으면 사용, 없으면 전역 ffmpeg)
// --------------------------------------------------
const { spawn } = require("child_process");

let ffmpegPath;

try {
  ffmpegPath = require("ffmpeg-static");
  console.log("[WORKER] 🎬 ffmpeg-static 모듈 로드됨:", ffmpegPath);
} catch (e) {
  console.warn(
    "[WORKER] ⚠ ffmpeg-static 모듈을 찾지 못했습니다. 전역 ffmpeg 바이너리를 시도합니다."
  );
  ffmpegPath = "ffmpeg"; // PATH에 있는 ffmpeg 사용 시도
}

// 기본 정보 로그
// --------------------------------------------------
console.log("[WORKER] ✅ Worker 시작됨");
console.log(`[WORKER] JobQueue URL (env): ${JOBQUEUE_WEBAPP_URL}`);
console.log(`[WORKER] BASE URL:           ${BASE_URL}`);
console.log(`[WORKER] NextJob URL:        ${NEXT_JOB_URL}`);
console.log(`[WORKER] JobStatus URL:      ${JOB_STATUS_URL}`);
console.log(`[WORKER] Poll interval:      ${POLL_INTERVAL_MS}ms`);

let isProcessing = false;

// 2) 유틸 함수들
// --------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// (테스트용) ffmpeg 스모크 테스트 – 실제 영상 작업 대신 짧게 돌렸다가 끝내기
async function runFfmpegSmokeTest(traceId) {
  console.log("[WORKER] 🎬 ffmpeg 스모크 테스트 시작:", traceId);

  // 필요하면 여기서 ffmpeg -version 같은 명령 실행하도록 확장 가능
  // 지금은 간단히 2초 대기만
  await sleep(2000);

  console.log("[WORKER] 🎬 ffmpeg 스모크 테스트 완료:", traceId);
}

// 작업 상태 업데이트 호출
async function reportJobStatus(payload) {
  try {
    const res = await fetch(JOB_STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await res.json().catch(() => null);
    console.log("[WORKER] 📡 update-job-status 응답:", json);
  } catch (e) {
    console.error("[WORKER] ❌ update-job-status 실패:", e.message || e);
  }
}

// 3) /next-job 폴링 한 번 수행
// --------------------------------------------------

async function pollOnce() {
  if (isProcessing) {
    console.log("[WORKER] ⏳ 이미 작업 처리 중이어서 이번 폴링은 스킵합니다.");
    return;
  }

  console.log(
    `\n[WORKER] 🚚 /next-job 폴링 (${new Date().toISOString()}) ->`,
    NEXT_JOB_URL
  );

  try {
    const res = await fetch(NEXT_JOB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      console.error("[WORKER] ❌ /next-job 응답 JSON 파싱 실패:", e.message || e);
    }

    console.log("[WORKER] /next-job 응답:", data);

    if (!data || data.ok === false) {
      console.error(
        "[WORKER] ❌ next-job 실패:",
        data && data.error ? data.error : "응답 형식 오류 또는 ok:false"
      );
      return;
    }

    if (!data.has_job || !data.job) {
      console.log("[WORKER] 😴 대기 중: 처리할 작업이 없습니다.");
      return;
    }

    const job = data.job;
    isProcessing = true;

    console.log(
      "[WORKER] ✅ 작업 수신:",
      "trace_id:",
      job.trace_id,
      "step:",
      job.step,
      "type:",
      job.type
    );

    // 여기서 실제 처리 로직 수행 (지금은 ffmpeg 스모크 테스트 + 상태완료 보고)
    await runFfmpegSmokeTest(job.trace_id);

    await reportJobStatus({
      trace_id: job.trace_id,
      step: "done",
      ok: true,
      worker_id: WORKER_ID,
      note: "worker_mock.js test 완료",
    });

    console.log("[WORKER] ✅ 작업 처리 완료:", job.trace_id);
  } catch (e) {
    console.error("[WORKER] ❌ /next-job 폴링 중 에러:", e.message || e);
  } finally {
    isProcessing = false;
  }
}

// 4) 메인 폴링 루프 시작
// --------------------------------------------------

(async () => {
  // 바로 한 번 폴링해보고
  await pollOnce();
  // 이후에는 interval 로 계속 폴링
  setInterval(pollOnce, POLL_INTERVAL_MS);
})();

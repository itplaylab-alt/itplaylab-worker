// worker_mock.js
// ItplayLab JobQueue Worker (Render용, /next-job 폴링 + ffmpeg 스모크 테스트)

// ───────────────────────────────────────
// 1. 기본 설정 & 환경변수
// ───────────────────────────────────────

const JOBQUEUE_WEBAPP_URL = process.env.JOBQUEUE_WEBAPP_URL; // 예: https://itplaylab-server.onrender.com/next-job
const JOBQUEUE_WORKER_SECRET = process.env.JOBQUEUE_WORKER_SECRET || "";
const POLL_INTERVAL_MS = 5000; // 5초마다 폴링
const WORKER_ID = process.env.WORKER_ID || "itplaylab-worker-1";

console.log(
  "[WORKER] DEBUG WORKER_ID env:",
  process.env.WORKER_ID,
  "local:",
  WORKER_ID
);

// ✅ 완료 상태 업데이트용 URL (/update-job-status)
const JOB_STATUS_URL =
  JOBQUEUE_WEBAPP_URL &&
  `${JOBQUEUE_WEBAPP_URL.replace(
    /\/next-job.*$/i,
    "/update-job-status"
  )}?secret=${encodeURIComponent(JOBQUEUE_WORKER_SECRET || "")}`;

// ✅ Worker 전용 /next-job 폴링 URL (secret 포함)
const NEXT_JOB_URL =
  JOBQUEUE_WEBAPP_URL &&
  `${JOBQUEUE_WEBAPP_URL.replace(
    /\/next-job.*$/i,
    "/next-job"
  )}?secret=${encodeURIComponent(JOBQUEUE_WORKER_SECRET || "")}`;

// ───────────────────────────────────────
// 2. ffmpeg (옵션: ffmpeg-static 있으면 사용, 없으면 전역 ffmpeg)
// ───────────────────────────────────────

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

// ───────────────────────────────────────
// 3. 필수 환경변수 체크
// ───────────────────────────────────────

if (!JOBQUEUE_WEBAPP_URL) {
  console.error(
    "[WORKER] ❌ 환경변수 JOBQUEUE_WEBAPP_URL 이 설정되지 않았습니다."
  );
  process.exit(1);
}

if (!JOBQUEUE_WORKER_SECRET) {
  console.warn(
    "[WORKER] ⚠ JOBQUEUE_WORKER_SECRET 이 비어있습니다. 서버에서 인증을 건다면 꼭 설정해야 합니다."
  );
}

// 기본 정보 로그
console.log("[WORKER] ✅ Worker 시작됨");
console.log(`[WORKER] JobQueue URL: ${JOBQUEUE_WEBAPP_URL}`);
console.log(`[WORKER] NextJob URL: ${NEXT_JOB_URL}`);
console.log(`[WORKER] JobStatus URL: ${JOB_STATUS_URL}`);
console.log(`[WORKER] Poll interval: ${POLL_INTERVAL_MS}ms`);

let isProcessing = false;

// ───────────────────────────────────────
// 4. 메인 폴링 루프
// ───────────────────────────────────────

async function pollOnce() {
  if (isProcessing) {
    // 혹시라도 겹쳐서 돌지 않도록 보호
    return;
  }

  isProcessing = true;

  try {
    console.log(
      `\n[WORKER] 🚚 /next-job 폴링 (${new Date().toISOString()})`
    );

    const res = await fetch(NEXT_JOB_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: WORKER_ID }),
    });

    const data = await res.json().catch(() => ({}));
    console.log(
      "[WORKER] /next-job 응답:",
      JSON.stringify(data, null, 2)
    );

    if (!data.ok) {
      console.error("[WORKER] ❌ next-job 실패:", data.error);
      return;
    }

    if (!data.has_job || !data.job) {
      console.log("[WORKER] ⏳ 대기 중 – 처리할 job 없음.");
      return;
    }

    const job = data.job;
    await handleJob(job);
  } catch (err) {
    console.error("[WORKER] ❌ pollOnce error:", err);
  } finally {
    isProcessing = false;
  }
}

// ───────────────────────────────────────
// 5. Job 처리 (모킹 버전)
// ───────────────────────────────────────

async function handleJob(job) {
  const traceId = job.trace_id || job.id || "unknown";
  console.log(
    `[WORKER] 🧾 Job 수신 trace_id=${traceId}, type=${job.type || "unknown"}`
  );

  // 서버에 "worker가 job 받았음" 알림
  await updateStatus(traceId, {
    step: "worker_received",
    status: "running",
    meta: { worker_id: WORKER_ID },
  });

  const startedAt = Date.now();

  try {
    console.log("[WORKER] 🎬 (mock) ffmpeg 작업 시작");

    // 🔧 여기서는 ffmpeg를 진짜 돌리기보다는, 간단하게 3초 대기해서 "스모크 테스트"만 함
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const durationMs = Date.now() - startedAt;

    await updateStatus(traceId, {
      step: "done",
      status: "success",
      output_url: job.output_url || "",
      latency_ms: durationMs,
    });

    console.log(
      `[WORKER] ✅ 작업 완료 trace_id=${traceId}, latency=${durationMs}ms`
    );
  } catch (err) {
    await updateStatus(traceId, {
      step: "error",
      status: "failed",
      error: String(err?.message || err),
    });

    console.error("[WORKER] ❌ 작업 중 오류:", err);
  }
}

// ───────────────────────────────────────
// 6. 서버에 상태 업데이트
// ───────────────────────────────────────

async function updateStatus(traceId, payload) {
  if (!JOB_STATUS_URL) {
    console.warn(
      "[WORKER] (updateStatus) JOB_STATUS_URL 없음. 서버에 상태 전송 생략."
    );
    return;
  }

  const body = {
    trace_id: traceId,
    worker_id: WORKER_ID,
    ...payload,
  };

  try {
    const res = await fetch(JOB_STATUS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    console.log(
      "[WORKER] ↪ update-job-status 응답:",
      JSON.stringify(data)
    );
  } catch (err) {
    console.error("[WORKER] ❌ updateStatus 오류:", err);
  }
}

// ───────────────────────────────────────
// 7. 폴링 시작
// ───────────────────────────────────────

setInterval(pollOnce, POLL_INTERVAL_MS);
console.log("[WORKER] ⏰ Poll loop started.");

pollOnce().catch((e) =>
  console.error("[WORKER] 초기 pollOnce 오류:", e)
);

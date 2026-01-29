// worker_mock.js
// ItplayLab JobQueue Worker (v8.5 SSOT: route/key/id/update-job-status만 연결)
// - next-job:    GET/POST  BASE_URL?route=next-job&key=...
// - update-job:  POST      BASE_URL?route=update-job-status&key=...  body:{id,status,...}

const JOBQUEUE_WEBAPP_URL = process.env.JOBQUEUE_WEBAPP_URL; // ✅ GAS WebApp /exec
const JOBQUEUE_API_KEY = process.env.JOBQUEUE_API_KEY || ""; // ✅ v8.5: worker 인증 키 (secret 금지)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const WORKER_ID = process.env.WORKER_ID || "itplaylab-worker-1";

console.log("[WORKER] DEBUG WORKER_ID env:", process.env.WORKER_ID, "local:", WORKER_ID);

if (!JOBQUEUE_WEBAPP_URL) {
  console.error("[WORKER] ❌ 환경변수 JOBQUEUE_WEBAPP_URL 이 설정되지 않았습니다.");
  process.exit(1);
}

if (!JOBQUEUE_API_KEY) {
  console.warn("[WORKER] ⚠ JOBQUEUE_API_KEY 가 비어있습니다. (인증 필요하면 반드시 설정)");
}

// ✅ GAS는 단일 엔드포인트(/exec) 라우터 방식이므로 URL을 그대로 BASE로 사용
const BASE_URL = JOBQUEUE_WEBAPP_URL;

// URL builder: route + key(쿼리) 붙이기
function buildUrl(route) {
  const u = new URL(BASE_URL);
  u.searchParams.set("route", route);
  if (JOBQUEUE_API_KEY) u.searchParams.set("key", JOBQUEUE_API_KEY); // ✅ v8.5 커넥터: key 통일
  return u.toString();
}

const NEXT_JOB_URL = buildUrl("next-job");
const UPDATE_STATUS_URL = buildUrl("update-job-status");

// ffmpeg (옵셔널: ffmpeg-static 있으면 사용, 없으면 전역 ffmpeg)
// --------------------------------------------------
const { spawn } = require("child_process");

let ffmpegPath;
try {
  ffmpegPath = require("ffmpeg-static");
  console.log("[WORKER] 🎬 ffmpeg-static 모듈 로드됨:", ffmpegPath);
} catch (e) {
  console.warn("[WORKER] ⚠ ffmpeg-static 모듈을 찾지 못했습니다. 전역 ffmpeg 바이너리를 시도합니다.");
  ffmpegPath = "ffmpeg";
}

// 기본 정보 로그
// --------------------------------------------------
console.log("[WORKER] ✅ Worker 시작됨");
console.log(`[WORKER] WebApp URL (env):   ${JOBQUEUE_WEBAPP_URL}`);
console.log(`[WORKER] BASE URL:           ${BASE_URL}`);
console.log(`[WORKER] NextJob URL:        ${NEXT_JOB_URL}`);
console.log(`[WORKER] UpdateStatus URL:   ${UPDATE_STATUS_URL}`);
console.log(`[WORKER] Poll interval:      ${POLL_INTERVAL_MS}ms`);

let isProcessing = false;

// 2) 유틸 함수들
// --------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// (테스트용) ffmpeg 스모크 테스트 – 실제 영상 작업 대신 짧게 돌렸다가 끝내기
async function runFfmpegSmokeTest(jobId) {
  console.log("[WORKER] 🎬 ffmpeg 스모크 테스트 시작:", jobId);

  // 지금은 간단히 2초 대기만
  await sleep(2000);

  console.log("[WORKER] 🎬 ffmpeg 스모크 테스트 완료:", jobId);
}

// ✅ v8.5: update-job-status로 DONE/ERROR만 보고
async function reportJobStatus({ id, status, error_message, result_url, note }) {
  const payload = {
    id,
    status, // 'DONE' | 'ERROR' | 'HOLD'
    ...(error_message ? { error_message } : {}),
    ...(result_url ? { result_url } : {}),
    ...(note ? { note } : {}),
    worker_id: WORKER_ID,
  };

  try {
    const res = await fetch(UPDATE_STATUS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        // 대안 인증(헤더)도 가능: v8.5 SSOT 허용
        ...(JOBQUEUE_API_KEY ? { "x-jobqueue-api-key": JOBQUEUE_API_KEY } : {}),
      },
      body: JSON.stringify(payload),
    });

    const json = await res.json().catch(() => null);
    console.log("[WORKER] 📡 update-job-status 응답:", json);
    return json;
  } catch (e) {
    console.error("[WORKER] ❌ update-job-status 실패:", e.message || e);
    return null;
  }
}

// ✅ GAS 응답에서 id/payload 뽑기 (trace_id 금지)
function extractJob(data) {
  // SSOT: GAS 실제는 { ok:true, job:{ id, status, payload_json, ... } } 형태
  if (!data || data.ok !== true || !data.job || !data.job.id) return null;

  const id = data.job.id;

  let payload = data.job.payload_json;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch (_) {}
  }

  return { id, payload, raw: data.job };
}

// 3) /next-job 폴링 한 번 수행
// --------------------------------------------------
async function pollOnce() {
  if (isProcessing) {
    console.log("[WORKER] ⏳ 이미 작업 처리 중이어서 이번 폴링은 스킵합니다.");
    return;
  }

  console.log(`\n[WORKER] 🚚 next-job 폴링 (${new Date().toISOString()}) ->`, NEXT_JOB_URL);

  try {
    // ✅ next-job: route 기반. GET이든 POST든 되게 해두되, 우선 POST 유지
    const res = await fetch(NEXT_JOB_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(JOBQUEUE_API_KEY ? { "x-jobqueue-api-key": JOBQUEUE_API_KEY } : {}),
      },
      body: JSON.stringify({
        worker_id: WORKER_ID,
      }),
    });

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      console.error("[WORKER] ❌ next-job 응답 JSON 파싱 실패:", e.message || e);
    }

    console.log("[WORKER] next-job 응답:", data);

    if (!data || data.ok === false) {
      console.error(
        "[WORKER] ❌ next-job 실패:",
        data && data.error ? data.error : "응답 형식 오류 또는 ok:false"
      );
      return;
    }

    // ✅ GAS 실제 스키마 기준으로 처리 (has_job 기대 제거)
    const job = extractJob(data);
    if (!job) {
      console.log("[WORKER] 😴 대기 중: 처리할 작업이 없습니다. (또는 스키마 불일치)");
      return;
    }

    isProcessing = true;
    console.log("[WORKER] ✅ 작업 수신:", "id:", job.id);

    // 여기서 실제 처리 로직 수행 (지금은 ffmpeg 스모크 테스트 + 상태완료 보고)
    try {
      await runFfmpegSmokeTest(job.id);

      await reportJobStatus({
        id: job.id,
        status: "DONE",
        note: "worker_mock.js v8.5 connect_probe 완료",
      });

      console.log("[WORKER] ✅ 작업 처리 완료:", job.id);
    } catch (err) {
      await reportJobStatus({
        id: job.id,
        status: "ERROR",
        error_message: err?.message || String(err),
        note: "worker_mock.js v8.5 connect_probe 실패",
      });
      console.error("[WORKER] ❌ 작업 처리 실패:", job.id, err?.message || err);
    }
  } catch (e) {
    console.error("[WORKER] ❌ next-job 폴링 중 에러:", e.message || e);
  } finally {
    isProcessing = false;
  }
}

// 4) 메인 폴링 루프 시작
// --------------------------------------------------
(async () => {
  await pollOnce();
  setInterval(pollOnce, POLL_INTERVAL_MS);
})();

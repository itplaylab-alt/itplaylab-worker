// worker_mock.js
// ItplayLab JobQueue Worker (Render용, /next-job 폴링 + ffmpeg 스모크 테스트)

const JOBQUEUE_WEBAPP_URL = process.env.JOBQUEUE_WEBAPP_URL;
const JOBQUEUE_WORKER_SECRET = process.env.JOBQUEUE_WORKER_SECRET || "";
const POLL_INTERVAL_MS = 5000; // 5초마다 폴링

// ✅ 완료 상태 업데이트용 엔드포인트 URL
//    서버에서 /update-job-status 같은 라우트를 쓸 거라고 가정하고 만듦
const JOB_STATUS_URL =
  JOBQUEUE_WEBAPP_URL &&
  JOBQUEUE_WEBAPP_URL.replace(/\/next-job.*$/i, "/update-job-status");

// ffmpeg (옵셔널: ffmpeg-static 있으면 사용, 없으면 전역 ffmpeg)
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

console.log("[WORKER] ✅ Worker 시작됨");
console.log(`[WORKER] JobQueue URL: ${JOBQUEUE_WEBAPP_URL}`);
console.log(`[WORKER] Poll interval: ${POLL_INTERVAL_MS}ms`);

let isProcessing = false;

// ____________________________
// 메인 폴링 루프
// ____________________________

async function pollOnce() {
  console.log(`\n[WORKER] 🛰 /next-job 요청 (${new Date().toISOString()})`);

  let raw;
  try {
    const res = await fetch(`${JOBQUEUE_WEBAPP_URL}/next-job`, {
      method: "GET", // 지금 서버가 GET 받아주고 있으면 그대로 두고,
      // 가능하면 나중에 POST로 바꾸는 게 베스트
      headers: {
        Accept: "application/json",
        "x-jobqueue-secret": JOBQUEUE_WORKER_SECRET,
      },
    });

    raw = await res.text();
  } catch (err) {
    console.error("[WORKER] ❌ /next-job 호출 실패:", err.message || err);
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(
      "[WORKER] ❌ /next-job JSON 파싱 실패. 응답 일부:",
      String(raw).slice(0, 200)
    );
    return;
  }

  const ok = data.ok;
  const hasJob = data.has_job;
  const job = data.job;

  if (!ok) {
    console.warn("[WORKER] ⚠️ /next-job 응답 ok:false", data);
    return;
  }

  if (!hasJob || !job) {
    console.log("[WORKER] 📭 PENDING job 없음 (has_job=false)");
    return;
  }

  console.log(
    `[WORKER] 📦 Job 할당됨: id=${job.id || "unknown"}, status=${
      job.status || "-"
    }`
  );

  try {
    await processJob(job);

    // ✅ Job 성공적으로 끝났을 때: DONE
    await updateJobStatus(job.id, "DONE");
    console.log(`[WORKER] ✅ Job 완료 처리: id=${job.id}, status=DONE`);
  } catch (err) {
    console.error(`[WORKER] ❌ Job 처리 실패: id=${job.id}`);
    console.error("  error:", err.message || err);

    try {
      // ✅ 실패했을 때: FAILED
      await updateJobStatus(job.id, "FAILED");
      console.log(`[WORKER] ⚠️ Job 상태를 FAILED 로 저장: id=${job.id}`);
    } catch (e2) {
      console.error(
        "[WORKER] ❌ FAILED 상태 업데이트도 실패",
        e2.message || e2
      );
    }
  }
}

// interval마다 돌리되, 이전 작업이 끝나지 않았으면 skip
async function pollLoop() {
  if (isProcessing) {
    console.log("[WORKER] ⏸ 이전 Job 처리 중, 이번 턴은 건너뜀");
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
console.log("[WORKER] 🚀 Polling loop started");

// ____________________________
// 실제 작업 로직 (ffmpeg로 5초짜리 테스트 영상 생성 + 썸네일 생성)
// ____________________________
async function processJob(job) {
  console.log(`[WORKER] 🛠 Job 처리 시작: id=${job.id}`);
  console.log(`[WORKER] ▶ ffmpeg binary: ${ffmpegPath}`);

  // 1) ffmpeg 버전 체크
  try {
    await runFfmpegVersion();
  } catch (err) {
    console.error("[WORKER] ❌ ffmpeg 버전 확인 실패:", err.message || err);
    throw err;
  }

  // 2) 출력 영상 경로
  const outputPath = `/tmp/job_${job.id}.mp4`;
  console.log(`[WORKER] ▶ 테스트 영상 렌더링 시작: ${outputPath}`);

  try {
    await renderTestVideo(outputPath);
    console.log(`[WORKER] ✅ 테스트 영상 렌더링 완료: ${outputPath}`);

    // 3) 썸네일 생성
    const thumbPath = `/tmp/job_${job.id}.jpg`;
    console.log(
      `[WORKER] ▶ 썸네일 생성 시작: input=${outputPath}, output=${thumbPath}`
    );

    await renderThumbnail(outputPath, thumbPath);
    console.log(`[WORKER] ✅ 썸네일 생성 완료: ${thumbPath}`);
  } catch (err) {
    console.error(
      "[WORKER] ❌ 테스트 영상/썸네일 생성 실패:",
      err.message || err
    );
    throw err;
  }

  console.log(`[WORKER] ✅ Job 처리 완료: id=${job.id}`);
}

// ____________________________
// Job 상태 업데이트 (DONE / FAILED 서버에 전달)
// ____________________________
async function updateJobStatus(id, status) {
  if (!JOB_STATUS_URL) {
    console.warn(
      "[WORKER] ⚠ JOB_STATUS_URL 이 설정되지 않아 상태 업데이트를 건너뜁니다.",
      { id, status }
    );
    return;
  }

  const body = {
    id,
    status,
  };

  try {
    const res = await fetch(JOB_STATUS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-jobqueue-secret": JOBQUEUE_WORKER_SECRET,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let json;

    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }

    if (!res.ok || (json && json.ok === false)) {
      console.warn(
        "[WORKER] ⚠ Job 상태 업데이트 응답이 정상적이지 않습니다.",
        "status code=",
        res.status,
        "response=",
        json
      );
    } else {
      console.log(
        `[WORKER] 🔄 Job 상태 업데이트 성공: id=${id}, status=${status}`
      );
    }
  } catch (err) {
    console.error(
      "[WORKER] ❌ Job 상태 업데이트 요청 실패:",
      err.message || err
    );
  }
}

// ____________________________
// ffmpeg 유틸
// ____________________________

function runFfmpegVersion() {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ["-version"]);

    let output = "";

    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (output += data.toString()));

    child.on("close", (code) => {
      if (code === 0) {
        const firstLine = output.split("\n")[0];
        console.log("[WORKER] ffmpeg -version 출력 (첫 줄):", firstLine);
        resolve();
      } else {
        reject(new Error(`ffmpeg 종료 코드 ${code}\n${output}`));
      }
    });
  });
}

// ==========================
//  테스트 영상 생성 함수
// ==========================

function renderTestVideo(outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=1280x720:d=5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ];

    console.log("[WORKER] ▶ ffmpeg 실행:", ffmpegPath, args.join(" "));

    const child = spawn(ffmpegPath, args);
    let output = "";

    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (output += data.toString()));
    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 종료 코드 ${code}\n${output}`));
    });
  });
}

// ==========================
//  썸네일 생성 함수
// ==========================

function renderThumbnail(inputPath, thumbPath) {
  return new Promise((resolve, reject) => {
    console.log(
      `[WORKER] ▶ 썸네일 생성 시작(내부 ffmpeg): input=${inputPath}, output=${thumbPath}`
    );

    const args = [
      "-ss",
      "00:00:01", // 1초 지점
      "-i",
      inputPath, // mp4
      "-vframes",
      "1", // 1장
      "-q:v",
      "2", // 화질
      thumbPath,
    ];

    const child = spawn(ffmpegPath, args);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));

    child.on("close", (code) => {
      if (code === 0) {
        console.log(`[WORKER] 👍 썸네일 생성 완료: ${thumbPath}`);
        resolve();
      } else {
        console.error("[WORKER] ❌ 썸네일 생성 실패");
        reject(
          new Error(`ffmpeg thumbnail exited with code ${code}\n${stderr}`)
        );
      }
    });

    child.on("error", (err) => {
      console.error("[WORKER] ❌ 썸네일 생성 중 프로세스 에러:", err);
      reject(err);
    });
  });
}

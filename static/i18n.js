"use strict";
// UI language (ko | en). Korean is the source text; EN maps it to English.
// - Fixed text in index.html is translated once on load by i18nDom() (text nodes + title/placeholder/aria-label).
// - Text built in app.js goes through t("한국어 {n}", { n }).
// Switching language reloads the page (setLang), so nothing has to be re-rendered live.
const LANG = (() => {
  try { const s = localStorage.getItem("meari.lang"); if (s === "ko" || s === "en") return s; } catch {}
  return /^ko\b/i.test(navigator.language || "") ? "ko" : "en";
})();
const LOCALE = LANG === "en" ? "en-US" : "ko-KR";

const EN = {
  // ---- index.html
  "메아리": "Meari",
  "확인 중": "Checking",
  "로컬 강의·회의 노트": "Local lecture & meeting notes",
  "새 노트 녹음": "New recording",
  "파일로 만들기": "From a file",
  "노트": "Notes",
  "엔진 확인 중…": "Checking engine…",
  "Nemotron · 이 PC 안에서만": "Nemotron · on this PC only",
  "엔진 끄기": "Engine off",
  "엔진 켜기": "Engine on",
  "모두 끄기": "Turn all off",
  "메아리 · 로컬 강의·회의 노트": "Meari · local lecture & meeting notes",
  "말은 흘러가도,": "Words fade —",
  "는 남습니다.": " keeps them.",
  "강의와 회의를 녹음하면 실시간으로 받아쓰고, 끝나면 화자별 원고·요약 노트·복습 퀴즈로 되돌려 드려요.": "Record a lecture or meeting and it is transcribed live; when you stop, you get a speaker transcript, a summary note and a study quiz.",
  "지금 녹음 시작": "Start recording now",
  "처음 한 번, 브라우저가 마이크 권한을 물어봐요": "The first time, the browser asks for microphone permission",
  "엔진은 켜지는 중(약 3분) — 녹음은 바로 되고, 준비되면 따라잡아 받아써요": "The engine is starting (~3 min) — recording works now and transcription catches up when it is ready",
  "마이크": "Mic",
  "탭 소리": "Tab audio",
  "둘 다": "Both",
  "실시간 영어 번역": "Live English translation",
  "— 녹음·영상 파일을 올려요": "— upload an audio or video file",
  "듣기": "Listen",
  "마이크, 온라인 강의 탭 소리, 또는 둘 다. 버튼 하나로 시작해요.": "Mic, tab audio from an online lecture, or both. One button to start.",
  "받아쓰기": "Transcribe",
  "말이 멈출 때마다(8~16초) 문장이 떠올라요. 원하면 영어 번역도 함께.": "A sentence appears at every pause (8–16 s), with an English translation if you like.",
  "멈추면 화자별 원고, 요약 노트, 퀴즈와 암기카드가 되돌아와요.": "Stop, and back come a speaker transcript, a summary note, a quiz and flashcards.",
  "모든 처리는 이 노트북 안에서만 이루어져요. 녹음도 원고도 밖으로 나가지 않아요.": "Everything runs on this laptop. Neither audio nor transcripts ever leave it.",
  "말하는 동안 받아쓰고, 멈추면 정리해요": "Transcribes while you talk, organizes when you stop",
  "바로 녹음돼요 · 엔진이 켜지면(약 3분) 따라잡아 받아써요": "Records right away · transcription catches up once the engine is up (~3 min)",
  "최근 노트": "Recent notes",
  "최근 녹음순": "Newest first",
  "편집": "Edit",
  "편집 끝": "Done",
  "내보내기": "Export",
  "복습": "Study",
  "용어": "Terms",
  "녹음 시작": "Start recording",
  "강의 자료를 먼저 올려 두면 원고에 쪽 번호가 붙어요": "Upload slides first and transcript lines get page numbers",
  "요약 노트": "Summary",
  "강의 자료": "Materials",
  "영어 번역": "English",
  "질문": "Ask",
  "다시 정리하기": "Redo summary",
  "요약 고치기": "Edit summary",
  "저장": "Save",
  "취소": "Cancel",
  "확인": "OK",
  "자료 올리기 (PDF·PPTX·TXT)": "Upload material (PDF·PPTX·TXT)",
  "자료를 올리면 원고 문장 옆에 관련 페이지(p.3 등)가 붙고, 요약과 질문 답변에도 참고돼요.": "Uploaded material adds page links (p.3 …) next to transcript lines and is used for the summary and answers.",
  "영어로 번역하기": "Translate to English",
  "녹취록과 강의 자료를 바탕으로 답해요.": "Answers come from the transcript and the materials.",
  "원고": "Transcript",
  "화자별": "By speaker",
  "실시간 기록": "Live",
  "편집 모드 — 문장을 눌러 고치면 자동 저장돼요. 화자 이름을 누르면 화자를 바꿀 수 있어요.": "Edit mode — click a sentence to fix it; changes save automatically. Click a speaker name to change the speaker.",
  "퀴즈": "Quiz",
  "복습 자료 만들기": "Make study set",
  "새로 만들기": "Regenerate",
  "암기카드": "Flashcards",
  "눌러서 뒤집기 ·": "Click to flip ·",
  "넘기기": "to move",
  "녹음 중": "Recording",
  "입력 확인 중": "Checking input",
  "이번 구간": "This chunk",
  "초": "s",
  "녹음할 소리": "Source",
  "녹음 중에는 바꿀 수 없어요": "Locked while recording",
  "길게 눌러 멈추고 정리": "Press and hold to stop",
  "입력": "Input",
  "메아리가 돌아오고 있어요": "Meari is coming back with your note",
  "남은 부분 받아쓰기": "Transcribe the rest",
  "화자별 원고": "Speaker transcript",
  "창을 닫아도 정리는 계속돼요. 끝나면 노트가 열려요.": "Processing continues even if you close the window. The note opens when it is done.",
  "노트로 가기": "Go to note",
  "실시간 원고": "Live transcript",
  "0줄": "0 lines",
  "8–16초 사이, 말이 멈춘 곳에서 한 줄이 돼요": "A new line every 8–16 s, cut where speech pauses",
  "최신으로": "Latest",
  "처음": "Start",
  "지금": "Now",
  "메아리 홈으로": "Meari home",
  "노트 목록과 검색": "Notes and search",
  "노트 목록과 엔진": "Notes and engine",
  "모든 노트에서 검색": "Search all notes",
  "GPU 메모리만 비우고 앱은 그대로 둡니다": "Free GPU memory only; the app stays open",
  "앱과 엔진을 모두 끕니다": "Turn off the app and the engine",
  "최근 7일": "Last 7 days",
  "노트 제목": "Note title",
  "원고를 직접 고칩니다": "Edit the transcript",
  "요약·원고·번역·암기카드·퀴즈·질문을 마크다운으로 저장": "Save summary, transcript, translation, cards, quiz and Q&A as Markdown",
  "노트 삭제": "Delete note",
  "노트 보기 방식": "Note view",
  "자주 나올 용어·이름 (쉼표로 구분) — 요약 노트에서 표기를 바로잡는 데 쓰여요": "Frequent terms and names (comma-separated) — used to fix spelling in the summary",
  "자주 나올 용어·이름 (쉼표로 구분)": "Frequent terms and names (comma-separated)",
  "재생": "Play",
  "일시정지": "Pause",
  "재생 위치": "Position",
  "재생 속도": "Speed",
  "정리된 것": "Organized",
  "요약 노트 마크다운": "Summary Markdown",
  "이 노트에 대해 물어보세요 — 예: 시험에 나온다고 한 부분은?": "Ask about this note — e.g. what did they say will be on the exam?",
  "이 노트에 질문하기": "Ask this note",
  "원고 보기": "Transcript view",
  "실시간 영어 번역을 문장 아래에 겹쳐 보기": "Show the live English translation under each line",
  "녹음": "Recording",
  "지금 녹음하고 있는 입력 장치": "Input device being recorded",
  "녹음 시간": "Recording time",
  "멈추고 정리하기 — 길게 누르기": "Stop and finish — press and hold",

  // ---- app.js
  "받아쓰는 중": "Transcribing",
  "화자별 원고 만드는 중": "Separating speakers",
  "요약 노트 만드는 중": "Writing the summary",
  "영어로 번역하는 중": "Translating to English",
  "복습 자료 만드는 중": "Making the study set",
  "엔진 켜는 중(약 3분) — 켜지면 이어서 정리해요": "Starting the engine (~3 min) — continues once it is up",
  "엔진 준비됨": "Engine ready",
  "준비됨": "Ready",
  "엔진 켜는 중… (약 3분)": "Starting engine… (~3 min)",
  "녹음은 지금 바로 할 수 있어요": "You can record right now",
  "켜는 중": "Starting",
  "엔진 꺼짐 · GPU 비워 둠": "Engine off · GPU freed",
  "녹음하면 자동으로 켜져요 (약 3분)": "Starts by itself when you record (~3 min)",
  "꺼짐": "Off",
  "밀린 받아쓰기 {n}개 · 켜지면 처리해요": "{n} chunks waiting · transcribed once it is up",
  "안 쓰면 {n}분 뒤 자동으로 꺼져요": "Turns off after {n} idle minutes",
  "곧 자동으로 꺼져요": "Turning off soon",
  "엔진을 켜는 중이에요 (약 3분)": "Starting the engine (~3 min)",
  "엔진을 껐어요. GPU 메모리를 비웠어요": "Engine off. GPU memory freed",
  "녹음을 먼저 멈춰 주세요.": "Stop the recording first.",
  "메아리를 모두 끌까요?": "Turn Meari off completely?",
  "엔진과 앱을 끄고 GPU 메모리(약 42GB)를 비워요. 노트는 그대로 남아요. 다시 쓰려면 바탕화면 메아리(Ctrl+Alt+M)를 누르세요. GPU만 비우려면 '엔진 끄기'를 쓰세요.": "Stops the engine and the app and frees GPU memory (~42 GB). Your notes stay. To use it again, open Meari from the desktop (Ctrl+Alt+M). To free only the GPU, use 'Engine off'.",
  "메아리를 껐어요": "Meari is off",
  "GPU 메모리를 비웠어요. 이 창을 닫아도 됩니다.": "GPU memory freed. You can close this window.",
  "녹음 중에는 홈으로 갈 수 없어요.": "You can't go home while recording.",
  "오늘": "Today",
  "어제": "Yesterday",
  "이번 주": "This week",
  "오류": "Error",
  "오류: {e}": "Error: {e}",
  "아직 노트가 없어요": "No notes yet",
  "첫 녹음을 마치면 여기에 날짜순으로 쌓여요.": "Your recordings will show up here, newest first.",
  "파일 · {s}": "File · {s}",
  "용어 · {s}": "Terms · {s}",
  "아직 녹음하지 않았어요": "Not recorded yet",
  "노트 {n}개를 녹음했어요": "{n} notes recorded",
  "이번 주에는 아직 녹음이 없어요": "No recordings this week yet",
  "검색 결과": "Results",
  "검색 결과가 없어요": "No results",
  "제목·원고·요약·번역·자료에서 찾아요.": "Searches titles, transcripts, summaries, translations and materials.",
  "요약": "Summary",
  "번역": "Translation",
  "제목": "Title",
  "자료 {s}": "Material {s}",
  "녹음 중에는 다른 노트로 옮길 수 없어요.": "You can't switch notes while recording.",
  " · 화자 {n}": " · {n} speakers",
  " · 자료 {n}": " · {n} materials",
  "처리하는 중": "Processing",
  "수정됨": "edited",
  "강의 자료 {n}쪽 보기": "Open material page {n}",
  "녹음을 시작하면 여기에 실시간으로 받아써져요.": "Start recording and the live transcript appears here.",
  "녹음을 멈추면 화자별로 정리된 원고가 만들어져요.": "When you stop, a speaker-separated transcript is made.",
  "{n}분 ~ (화자 번호는 30분 구간마다 새로 매겨져요)": "From {n} min (speaker numbers restart every 30 minutes)",
  "화자 {n}": "Speaker {n}",
  "{a}문단 · 화자 {b}명": "{a} paragraphs · {b} speakers",
  "{n}줄 · 받아쓴 그대로": "{n} lines · as transcribed",
  "저장 실패: {e}": "Save failed: {e}",
  "녹음을 멈추면 요약 노트가 자동으로 만들어져요.": "When you stop recording, a summary note is made automatically.",
  "요약 노트를 저장했어요": "Summary saved",
  "화자별 원고를 영어로 번역해요. (이 모델은 영어 번역만 안정적으로 지원해요)": "Translates the speaker transcript into English. (This model translates reliably into English only.)",
  "아직 질문이 없어요. 아래 칸에 물어보세요.": "No questions yet. Ask below.",
  "원고와 자료에서 찾는 중…": "Searching the transcript and materials…",
  "{n}쪽": "{n} pages",
  "삭제": "Delete",
  "이 자료를 지울까요?": "Delete this material?",
  "원고에 붙은 쪽 번호도 함께 사라져요.": "Its page links in the transcript go too.",
  "이전 쪽": "Previous page",
  "다음 쪽": "Next page",
  "새 창에서 열기": "Open in a new window",
  "(이 쪽에는 글자가 없어요)": "(No text on this page)",
  "이 쪽을 설명한 곳": "Where this page was discussed",
  "이 쪽과 이어진 문장이 없어요.": "No transcript lines link to this page.",
  "자료 읽는 중…": "Reading the material…",
  "자료에서 글자를 찾지 못했어요(스캔본일 수 있어요). 보기는 되지만 원고와 연결되지는 않아요.": "No text found in the file (it may be a scan). You can view it, but it won't link to the transcript.",
  "퀴즈와 암기카드": "Quiz and flashcards",
  "원고를 바탕으로 객관식 퀴즈와 암기카드를 만들어요. 위의 <b>복습 자료 만들기</b>를 눌러 주세요.": "Makes a multiple-choice quiz and flashcards from the transcript. Press <b>Make study set</b> above.",
  "지금 {job} — 끝나면 복습 자료를 만들 수 있어요.": "Now: {job}. You can make the study set when it finishes.",
  "복습 자료를 만들면 여기에 암기카드가 나와요.": "Flashcards appear here once you make a study set.",
  "정답": "Correct",
  "오답": "Wrong",
  "내 답": "Your answer",
  "정답!": "Correct!",
  "오답 — 정답은 {k}.": "Wrong — the answer is {k}.",
  "이번에는 퀴즈가 만들어지지 않았어요.": "No quiz was made this time.",
  "<b>{a}문제 중 {b}문제</b> 풀었어요 · {c}개 맞음": "<b>{b} of {a}</b> answered · {c} correct",
  "<b>퀴즈 {n}문제</b> · 보기를 눌러 풀어 보세요": "<b>{n}-question quiz</b> · pick an answer",
  "이번에는 암기카드가 만들어지지 않았어요.": "No flashcards were made this time.",
  "암기카드 뒤집기": "Flip card",
  "눌러서 뜻 보기": "Tap to reveal",
  "이전 카드": "Previous card",
  "다음 카드": "Next card",
  "녹음 중에는 지울 수 없어요.": "You can't delete while recording.",
  "이 노트를 지울까요?": "Delete this note?",
  "'{t}' 노트와 녹음 파일을 지울까요? 되돌릴 수 없어요.": "Delete '{t}' and its recording? This can't be undone.",
  "노트를 지웠어요": "Note deleted",
  "녹음 중에는 파일을 올릴 수 없어요.": "You can't upload while recording.",
  "엔진을 켜는 중이에요. 켜지면(약 3분) 받아쓰기를 시작해요": "Starting the engine. Transcription begins once it is up (~3 min)",
  "파일 올리는 중…": "Uploading…",
  "녹음 파일을 불러오지 못했어요 ({n})": "Couldn't load the recording ({n})",
  "마이크 + 탭 소리": "Mic + tab audio",
  "이 브라우저는 탭 소리 녹음을 지원하지 않아요": "This browser can't record tab audio",
  "녹음 중에는 녹음할 소리를 바꿀 수 없어요.": "You can't change the source while recording.",
  "다음 줄부터 영어 번역을 함께 받아써요": "English translation on from the next line",
  "다음 줄부터 영어 번역 없이 받아써요": "English translation off from the next line",
  "녹음은 바로 시작해요. 엔진이 켜지면(약 3분) 따라잡아 받아써요": "Recording now. Transcription catches up once the engine is up (~3 min)",
  "이 주소에서는 마이크를 쓸 수 없어요. 휴대폰이라면 https 주소로 접속해 주세요.": "The microphone isn't available on this address. On a phone, use the https address.",
  "공유 창에서 '탭 오디오 공유'(또는 시스템 오디오)를 켜 주세요.": "Turn on 'Share tab audio' (or system audio) in the share dialog.",
  "오디오를 가져올 수 없어요: {e}": "Can't get audio: {e}",
  "오디오를 처리할 수 없어요: {e}": "Can't process audio: {e}",
  "입력 · {m}": "Input · {m}",
  "입력 장치 이름을 알 수 없어요": "Unknown input device",
  "말하는 내용이 10초 안팎 간격으로 받아써져요": "Speech is transcribed about every 10 seconds",
  " · 입력: {m}": " · input: {m}",
  "소리가 전혀 들어오지 않아요 — 지금은 아무것도 녹음되지 않고 있어요": "No sound at all — nothing is being recorded right now",
  "30초 동안 말소리가 감지되지 않았어요": "No speech detected for 30 seconds",
  "마이크가 음소거된 것 같아요 — 키보드의 마이크 키나 Windows 설정 > 시스템 > 소리 > 입력에서 음소거를 풀어 주세요.": "The mic seems muted — unmute it with the keyboard mic key or in Windows Settings > System > Sound > Input.",
  "마이크 위치나 입력 장치를 확인해 보세요.": "Check the mic position or the input device.",
  " (지금 입력: {m})": " (current input: {m})",
  "⚠ 소리 없음 — 메아리": "⚠ No sound — Meari",
  "받아쓰기 실패: {e}": "Transcription failed: {e}",
  "앞의 {n}줄은 접어 두었어요 · 눌러서 펼치기": "{n} earlier lines folded · click to expand",
  "말이 멈출 때마다 여기에 한 줄씩 받아써져요.": "Each pause in speech adds a line here.",
  "{n}줄": "{n} lines",
  "받아쓰는 중…": "Transcribing…",
  "엔진이 켜지면 받아써요 · 소리는 저장됐어요": "Transcribed once the engine is up · audio saved",
  "남은 부분 받아쓰는 중…": "Transcribing the rest…",
  "정리하는 중": "Finishing up",
  "녹음 끝": "Recording ended",
  "노트가 준비됐어요 — 요약 노트부터 보여드려요": "Your note is ready — here is the summary",
  "멈추려면 0.7초 동안 길게 눌러 주세요": "Press and hold for 0.7 s to stop",
  "아무 키나 누르거나 클릭하면 녹음이 시작돼요": "Press any key or click to start recording",
  "바로가기로 열린 창은 브라우저가 소리를 잠시 막아 둬요": "Browsers hold back audio in windows opened from a shortcut",
  "다른 창에서 이미 녹음 중이에요": "Already recording in another window",
  "이미 녹음 중이에요": "Already recording",
  "녹음 중에는 엔진을 끌 수 없어요": "You can't turn the engine off while recording",
  "녹음 중에는 언어를 바꿀 수 없어요.": "You can't change the language while recording.",

  // ---- server messages (shown in toasts and on notes)
  "PDF, PPTX, TXT, MD 파일만 올릴 수 있어요": "Only PDF, PPTX, TXT and MD files are supported",
  "녹음이 끝나면 답할 수 있어요": "I can answer once the recording ends",
  "정리 중인 노트가 끝난 뒤에 바꿀 수 있어요": "You can change it once the note being processed is done",
  "요약 엔진": "Summary engine",
  "요약·퀴즈·질문 답변을 만드는 모델": "Model that writes summaries, quizzes and answers",
  "원고가 PC 밖(클라우드)으로 보내져요": "Transcripts are sent off this PC (cloud)",
  "구독 · 클라우드": "subscription · cloud",
  "로컬 {n}GB": "local {n} GB",
  "클라우드 엔진으로 바꿀까요?": "Switch to a cloud engine?",
  "요약·퀴즈·질문 답변을 만들 때 원고가 {s} 쪽으로 보내져요. 녹음 파일은 보내지 않아요. 구독 사용량이 조금씩 쓰여요.": "Transcripts are sent to {s} to write summaries, quizzes and answers. Audio files are not sent. This uses a little of your subscription.",
  "바꾸기": "Switch",
  "요약 엔진: {s}": "Summary engine: {s}",
  "녹음을 멈추면 화자별 원고가 만들어지고, 그다음 요약 노트를 만들 수 있어요.": "When you stop recording, a speaker transcript is made; then you can make a summary note.",
  "원고가 준비됐어요. 요약 노트를 만들까요?": "The transcript is ready. Make a summary note?",
  "요약 노트 만들기": "Make summary note",
  "사이드바에서 바꿀 수 있어요": "change it in the sidebar",
  "요약 노트를 새로 만들까요?": "Make the summary note again?",
  "지금 고른 요약 엔진({s})으로 다시 만들어요. 직접 고친 내용은 사라져요.": "It is remade with the summary engine chosen now ({s}). Your own edits will be lost.",
  "원고가 준비됐어요 — 요약 노트는 버튼을 눌러 만들어요": "The transcript is ready — make the summary note with the button",
  "질문에 답할 엔진을 켜는 중이에요(약 20초). 준비되면 다시 질문해 주세요.": "Starting the engine that answers questions (~20 s). Ask again when it is ready.",
  "녹음된 소리가 없어요": "No recorded audio",
  "아직 정리 중인 노트가 있어요. 끝난 뒤에 꺼 주세요": "A note is still being processed. Turn it off when that finishes",
  "엔진을 켜는 중이에요(약 3분). 준비되면 다시 질문해 주세요.": "The engine is starting (~3 min). Ask again when it is ready.",
  "요청 본문이 UTF-8 JSON이 아니에요": "The request body is not UTF-8 JSON",
  "원고가 아직 없어요": "No transcript yet",
  "이미 처리 중이에요": "Already processing",
  "작업 중인 노트는 지울 수 없어요": "You can't delete a note that is being processed",
  "질문이 비어 있어요": "The question is empty",
  "녹음에 소리가 전혀 없어요. 마이크가 음소거되어 있었던 것 같아요 (Windows 설정 > 시스템 > 소리 > 입력, 또는 키보드 마이크 키).": "The recording has no sound at all. The mic was probably muted (Windows Settings > System > Sound > Input, or the keyboard mic key).",
};
// server messages that end with details after ": "
const EN_PREFIX = { "오디오를 읽을 수 없어요: ": "Can't read the audio: ", "자료를 읽을 수 없어요: ": "Can't read the material: " };

// The texts say the engine takes ~3 min (vLLM in WSL); the Windows-native engine starts in ~20 s.
let bootFast = false;
const fixBoot = (s) => (bootFast ? s.replace(/약 3분/g, "약 20초").replace(/~3 min/g, "~20 s") : s);
function t(ko, v) {
  let s = fixBoot(LANG === "en" && EN[ko] != null ? EN[ko] : ko);
  return v ? s.replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? "")) : s;
}
// once the server says its engine starts quickly: fix texts already on the page and in BUSY
function useFastBoot(busy) {
  if (bootFast) return;
  bootFast = true;
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) if (/약 3분|~3 min/.test(n.nodeValue)) n.nodeValue = fixBoot(n.nodeValue);
  for (const k in busy) busy[k] = fixBoot(busy[k]);
}
// free text from the server (errors): exact match, then known prefixes
function tMsg(msg) {
  if (LANG !== "en" || !msg) return msg;
  if (EN[msg] != null) return EN[msg];
  for (const [ko, en] of Object.entries(EN_PREFIX)) if (msg.startsWith(ko)) return en + msg.slice(ko.length);
  return msg;
}
// search hit labels from the server: "원고", "화자별 원고", "요약", "번역", "제목", "자료 <name> p.N"
function tWhere(w) {
  const m = /^자료 (.*)$/.exec(w || "");
  return m ? t("자료 {s}", { s: m[1] }) : t(w);
}

function i18nDom(root) {
  if (LANG !== "en") return;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("script,style,[data-noi18n]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n; (n = tw.nextNode());) {
    const raw = n.nodeValue, key = raw.replace(/\s+/g, " ").trim();
    if (key && EN[key] != null) n.nodeValue = raw.replace(/^\s*/, (s) => s ? " " : "").replace(/\s*$/, (s) => s ? " " : "").replace(/\S[\s\S]*\S|\S/, EN[key]);
  }
  for (const a of ["title", "placeholder", "aria-label", "content"]) {
    root.querySelectorAll(`[${a}]`).forEach((el) => { const v = el.getAttribute(a); if (EN[v] != null) el.setAttribute(a, EN[v]); });
  }
}

function setLang(l) {
  try { localStorage.setItem("meari.lang", l); } catch {}
  location.reload();
}

document.documentElement.lang = LANG;
if (LANG === "en") { document.title = t(document.title); i18nDom(document.head); i18nDom(document.body); }

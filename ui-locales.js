(function initializeUiLocales(global) {
  "use strict";

  const SUPPORTED_PREFERENCES = new Set(["auto", "ko", "en"]);
  const TRANSLATABLE_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt", "label", "data-empty-label"];
  const IGNORED_CONTENT_SELECTOR = [
    "script",
    "style",
    "code",
    "pre",
    "#messageList",
    "#pageTitle",
    "#pageUrl",
    "[data-i18n-ignore]"
  ].join(",");

  const ENGLISH = Object.freeze({
    "대기 중": "Ready",
    "컨텍스트 확인": "View context",
    "마지막 작업 되돌리기": "Undo last action",
    "대화 내보내기": "Export conversation",
    "대화만 비우기": "Clear conversation",
    "자동형": "Automatic",
    "승인형": "Approval required",
    "MCP 꺼짐": "MCP off",
    "MCP 켜짐": "MCP on",
    "MCP 오류": "MCP error",
    "Bridge 꺼짐": "Bridge off",
    "Bridge 연결됨": "Bridge connected",
    "Bridge 오류": "Bridge error",
    "Bridge 연결 안 됨": "Bridge disconnected",
    "선택 없음": "Nothing selected",
    "접근할 수 없는 페이지": "Page unavailable",
    "다시 확인": "Check again",
    "외부 도구 실행 승인": "Approve external tool execution",
    "0건": "0 requests",
    "검토할 요청": "Request to review",
    "승인 후 실행": "Approve and run",
    "거부": "Reject",
    "에이전트 작업 승인": "Approve agent actions",
    "0개 작업": "0 actions",
    "계획과 확인 기준 보기": "View plan and verification criteria",
    "실행 대상 미리보기 보기": "Preview execution targets",
    "실행 대상 미리보기": "Execution target preview",
    "취소": "Cancel",
    "템플릿": "Templates",
    "요청 템플릿": "Task templates",
    "선택한 템플릿의 제목과 문구를 편집하거나, 새 템플릿을 만들어 저장합니다.": "Edit the selected template, or create and save a new one.",
    "새 템플릿 만들기": "Create a new template",
    "기본 템플릿": "Built-in templates",
    "내 템플릿": "My templates",
    "제목": "Title",
    "요청 문구": "Prompt",
    "새로 만들기": "New",
    "현재 입력 가져오기": "Use current input",
    "입력창에 넣기": "Insert into composer",
    "새로 저장": "Save new",
    "변경 저장": "Save changes",
    "수정됨": "modified",
    "삭제": "Delete",
    "삭제 확인": "Confirm deletion",
    "기본값 복원": "Restore default",
    "복원 확인": "Confirm restore",
    "중지": "Stop",
    "설정": "Settings",
    "표시 방식, AI 연결, 자동화와 외부 도구를 관리합니다. 변경 내용은 자동 저장됩니다.": "Manage display, AI connections, automation, and external tools. Changes are saved automatically.",
    "일반": "General",
    "AI 연결": "AI connection",
    "자동화": "Automation",
    "사이트별": "Per-site",
    "개발 도구": "Developer tools",
    "고급": "Advanced",
    "사용 환경": "Workspace",
    "확장 프로그램을 어디에 표시할지 선택하고 현재 구성을 한눈에 확인합니다.": "Choose where the extension opens and review the current configuration.",
    "열기 방식": "Open mode",
    "툴바의 확장 아이콘을 눌렀을 때 사용할 작업 공간입니다.": "Choose the workspace opened from the extension toolbar.",
    "기본 표시 위치": "Default location",
    "사이드 패널": "Side panel",
    "독립 탭": "Standalone tab",
    "선택한 방식으로 열기": "Open in selected mode",
    "표시 언어": "Display language",
    "브라우저 언어": "Browser language",
    "한국어": "Korean",
    "브라우저 언어를 따르거나 한국어와 영어를 직접 선택합니다. 변경 즉시 적용됩니다.": "Follow the browser language or choose Korean or English. Changes apply immediately.",
    "사이드 패널 위치 확인 중": "Checking side panel position",
    "좌우 위치는 확장 프로그램이 아니라 브라우저의 모양 설정을 따릅니다.": "The browser appearance setting controls whether the side panel is on the left or right.",
    "현재 구성": "Current configuration",
    "세부 설정을 바꾸면 이 요약에도 바로 반영됩니다.": "This summary updates as detailed settings change.",
    "모델 확인 중": "Checking model",
    "동작 방식 확인 중": "Checking automation mode",
    "외부 도구": "External tools",
    "연결 상태 확인 중": "Checking connection status",
    "사용할 API 형식과 모델, 인증 및 응답 옵션을 설정합니다.": "Configure the API format, model, authentication, and response options.",
    "연결": "Connection",
    "서버가 제공하는 API 형식에 맞춰 endpoint와 모델을 입력합니다.": "Enter the endpoint and model expected by the server.",
    "API 형식": "API format",
    "OpenAI 호환 Chat Completions": "OpenAI-compatible Chat Completions",
    "Anthropic 호환 Messages": "Anthropic-compatible Messages",
    "인증 값을 이 브라우저에 영구 저장 (공용 기기에서는 사용 금지)": "Store credentials persistently in this browser (do not use on shared devices)",
    "응답": "Response",
    "모델 응답의 형식과 생성 범위를 조절합니다.": "Control the model response format and generation limits.",
    "구조화 출력 사용": "Use structured output",
    "공급자 도구": "Provider tools",
    "현재 API 형식에서 지원할 때만 요청에 포함됩니다.": "Included only when supported by the selected API format.",
    "OpenAI Web Search 도구": "OpenAI Web Search tool",
    "OpenAI Code Interpreter 도구": "OpenAI Code Interpreter tool",
    "API 연결 테스트": "Test API connection",
    "에이전트의 실행 범위와 화면 관찰, 안전 장치를 조절합니다.": "Control the agent execution range, page observation, and safeguards.",
    "실행": "Execution",
    "한 요청에서 반복할 판단과 페이지 작업의 상한을 정합니다.": "Set limits for reasoning turns and page actions within one request.",
    "동작 모드": "Run mode",
    "최대 턴": "Maximum turns",
    "턴당 액션": "Actions per turn",
    "정체 허용 턴": "Stalled turns allowed",
    "API 제한 시간 (초)": "API timeout (seconds)",
    "API 재시도": "API retries",
    "화면 관찰": "Page observation",
    "AI가 한 번에 확인할 수 있는 페이지 정보의 범위를 정합니다.": "Set how much page information the AI can inspect at once.",
    "화면 텍스트 한도": "Page text limit",
    "요소 한도": "Element limit",
    "DOM으로 부족할 때 AI 판단과 승인 미리보기에 스크린샷 사용": "Use screenshots for AI decisions and approval previews when DOM evidence is insufficient",
    "안전": "Safety",
    "민감정보와 상태 변경 작업에 적용할 보호 장치입니다.": "Safeguards for sensitive data and state-changing actions.",
    "민감 입력 감지 시 중단": "Stop when sensitive input is detected",
    "민감정보 보호 모드": "Sensitive-data protection",
    "도구 실행 전 독립 정책 판정": "Run an independent policy check before tool execution",
    "현재 사이트 확인 중": "Checking current site",
    "브라우저 권한이 아니라, 현재 사이트에서만 사용할 에이전트 동작을 정합니다. 별도로 지정하지 않은 항목은 기본 설정을 따릅니다.": "Configure agent behavior for the current site only, independently of browser permissions. Unspecified options inherit the defaults.",
    "이 사이트에 별도 설정 적용": "Use separate settings for this site",
    "사이트 동작 모드": "Site run mode",
    "기본 설정 따르기": "Use default settings",
    "스크린샷": "Screenshots",
    "사용": "On",
    "사용 안 함": "Off",
    "사이트 프로필 저장": "Save site profile",
    "기본 설정으로 되돌리기": "Revert to defaults",
    "MCP 연결": "MCP connection",
    "원격 MCP 서버의 도구, 리소스와 프롬프트를 에이전트에 연결합니다.": "Connect tools, resources, and prompts from a remote MCP server to the agent.",
    "MCP 사용": "Enable MCP",
    "MCP 도구 실행 전 승인": "Require approval before running MCP tools",
    "MCP 인증 방식": "MCP authentication",
    "OAuth 연결 안 됨": "OAuth disconnected",
    "OAuth 연결": "Connect OAuth",
    "연결 해제": "Disconnect",
    "허용 MCP 도구": "Allowed MCP tools",
    "MCP 도구 확인": "Refresh MCP tools",
    "선택 도구 테스트": "Test selected tool",
    "Resources/Prompts 확인": "Refresh resources/prompts",
    "도구 0개": "0 tools",
    "테스트 arguments JSON": "Test arguments JSON",
    "리소스 0개": "0 resources",
    "리소스 읽기": "Read resource",
    "프롬프트 0개": "0 prompts",
    "프롬프트 arguments JSON": "Prompt arguments JSON",
    "프롬프트 가져오기": "Get prompt",
    "개발 도구 연결": "Developer tool connection",
    "로컬 MCP 개발 도구에 사용자가 선택한 웹 탭만 명시적으로 공유합니다.": "Explicitly share only the web tab you select with the local MCP developer tool.",
    "MCP 개발 도구 연결": "Connect MCP developer tool",
    "브리지를 MCP 개발 도구에 등록한 뒤, 실행 로그의": "After registering the bridge with your MCP developer tool, paste the",
    "값 하나를 아래에 붙여넣으세요. 연결과 현재 탭 공유를 한 번에 진행합니다.": "value from the startup log below. This connects and shares the current tab in one step.",
    "상태 변경 작업 전 항상 승인": "Always require approval before state-changing actions",
    "endpoint와 일회용 코드를 함께 처리합니다. 코드는 연결 직후 입력창과 저장 설정에서 제거됩니다.": "The endpoint and one-time code are handled together. The code is removed from the field and stored settings immediately after connection.",
    "연결하고 현재 탭 공유": "Connect and share current tab",
    "연결 권한 폐기": "Revoke connection permission",
    "연결 안 됨": "Disconnected",
    "세션 없음": "No session",
    "Extension setup 값을 붙여넣고 현재 탭을 공유해 주세요.": "Paste the Extension setup value and share the current tab.",
    "현재 탭 제어": "Current tab control",
    "연결된 탭이 없습니다.": "No tab is connected.",
    "현재 탭으로 변경": "Switch to current tab",
    "공유 중지": "Stop sharing",
    "고급 설정": "Advanced settings",
    "사용자 정의 요청 형식과 시스템 지침을 직접 조정합니다.": "Directly configure the custom request format and system instruction.",
    "설정 초기화": "Reset settings",
    "변경 내용은 자동 저장됩니다. 초기화하면 기본 설정으로 되돌립니다.": "Changes are saved automatically. Resetting restores the defaults.",
    "초기화": "Reset",
    "새로 읽기": "Refresh",
    "복사": "Copy",
    "Markdown 복사": "Copy Markdown",
    "Markdown 저장": "Save Markdown",
    "JSON 저장": "Save JSON",
    "CSV 저장": "Save CSV",
    "요소 선택": "Pick element",
    "더보기": "More",
    "보조 기능": "Utilities",
    "승인 대기 작업": "Actions awaiting approval",
    "검토할 외부 승인 요청": "External approval request to review",
    "작업 템플릿": "Task templates",
    "무엇을 도와드릴까요?": "How can I help?",
    "목록에 표시할 제목": "Title shown in the list",
    "입력창에 넣을 요청 문구": "Prompt inserted into the composer",
    "무엇을 할까요?": "What would you like to do?",
    "보내기": "Send",
    "닫기": "Close",
    "API에서 요구하는 모델명": "Model name required by the API",
    "쉼표 또는 줄바꿈으로 구분, 비우면 File Search 비활성화": "Separate with commas or line breaks; leave empty to disable File Search",
    "비우면 dynamic registration 시도": "Leave empty to try dynamic registration",
    "예: mcp.read mcp.write": "Example: mcp.read mcp.write",
    "비우면 전체 허용, 예: search, read_doc": "Leave empty to allow all, e.g. search, read_doc",
    "MCP 도구 선택": "Select an MCP tool",
    "MCP 리소스 선택": "Select an MCP resource",
    "MCP 프롬프트 선택": "Select an MCP prompt",
    "페이지 요약": "Summarize page",
    "현재 페이지의 핵심 내용을 구조적으로 요약해줘.": "Summarize the key points of the current page in a structured way.",
    "표 추출": "Extract table",
    "현재 페이지의 표나 목록 데이터를 찾아 CSV로 정리해줘.": "Find table or list data on the current page and organize it as CSV.",
    "폼 검토": "Review form",
    "현재 화면의 폼 항목을 검토하고 누락되거나 이상한 값이 있는지 확인해줘.": "Review the form fields on the current page and identify missing or unusual values.",
    "문서 비교": "Compare document",
    "현재 페이지의 문서 내용에서 변경점이나 중요한 차이를 찾아줘.": "Find changes or important differences in the document on the current page.",
    "테스트 케이스": "Test cases",
    "현재 화면의 기능을 기준으로 테스트 케이스를 작성해줘.": "Write test cases for the functionality visible on the current page.",
    "AI 판단": "AI decision",
    "도구 실행": "Run tools",
    "페이지 조작": "Act on page",
    "재확인": "Verify",
    "완료": "Done",
    "넓은 작업 공간을 유지하며, 같은 웹 탭에 연결된 작업 공간을 다시 사용합니다.": "Keeps a wide workspace and reuses the workspace connected to the same web tab.",
    "페이지 옆에서 대화와 승인 상태를 계속 확인할 수 있습니다.": "Keeps the conversation and approval state visible beside the page.",
    "현재 독립 탭에서 사용 중": "Currently using a standalone tab",
    "현재 사이드 패널에서 사용 중": "Currently using the side panel",
    "지금 독립 탭으로 열기": "Open in a standalone tab now",
    "지금 사이드 패널로 열기": "Open in the side panel now",
    "왼쪽": "Left",
    "오른쪽": "Right",
    "브라우저 설정": "Browser setting",
    "사이드 패널 위치는 브라우저에서 선택": "Choose the side panel position in the browser",
    "확장 프로그램은 현재 위치를 확인할 수 있지만 좌우 위치를 바꾸지는 않습니다. 브라우저의 모양 설정에서 변경할 수 있습니다.": "The extension can detect the current position but cannot move the panel. Change it in the browser appearance settings.",
    "이 브라우저에서는 사이드 패널을 열 수 없어 독립 탭으로 자동 전환합니다.": "This browser cannot open a side panel, so the extension automatically uses a standalone tab.",
    "API 형식 미지정": "API format not set",
    "모델 미지정": "Model not set",
    "동작 모드 미지정": "Run mode not set",
    "화면 요소 우선 · 필요할 때 스크린샷": "Prioritizes page elements and uses screenshots when needed",
    "화면 요소로만 판단": "Uses page elements only",
    "외부 연동 꺼짐": "External integrations off",
    "상태 변경 작업 승인 사용": "Approval required for state-changing actions",
    "기본 실행 정책 적용": "Default execution policy",
    "독립 탭에서 열었습니다.": "Opened in a standalone tab.",
    "이 브라우저에서는 사이드 패널을 열 수 없습니다.": "This browser cannot open a side panel.",
    "사이드 패널을 열 웹 탭을 확인하지 못했습니다.": "Could not identify the web tab for the side panel.",
    "사이드 패널에서 열었습니다.": "Opened in the side panel.",
    "이전 대화 복원됨": "Previous conversation restored",
    "제목과 요청 문구를 입력하거나 현재 입력을 가져오세요.": "Enter a title and prompt, or import the current composer input.",
    "기본 템플릿의 수정본입니다. 저장하거나 기본값으로 복원할 수 있습니다.": "This is a customized built-in template. Save it or restore the default.",
    "기본 제공 템플릿입니다. 수정 내용을 저장하면 이 브라우저에 덮어씁니다.": "This is a built-in template. Saving changes stores an override in this browser.",
    "저장된 내 템플릿입니다. 제목과 요청 문구를 바로 수정할 수 있습니다.": "This is one of your saved templates. You can edit its title and prompt.",
    "저장되지 않은 변경사항이 있습니다.": "There are unsaved changes.",
    "현재 입력창에 가져올 내용이 없습니다.": "There is no composer text to import.",
    "현재 입력을 편집기로 가져왔습니다. 저장 전 제목과 문구를 확인하세요.": "The current input was imported. Review the title and prompt before saving.",
    "템플릿 제목을 입력해 주세요.": "Enter a template title.",
    "저장할 요청 문구를 입력해 주세요.": "Enter a prompt to save.",
    "같은 제목의 템플릿이 이미 있습니다. 다른 제목을 사용해 주세요.": "A template with the same title already exists. Use a different title.",
    "템플릿 변경사항을 저장했습니다.": "Template changes saved.",
    "새 템플릿을 저장했습니다.": "New template saved.",
    "복원 확인을 한 번 더 누르면 저장한 수정본을 지우고 기본값으로 되돌립니다.": "Press confirm restore again to remove the saved override and restore the default.",
    "기본 템플릿을 원래 제목과 요청 문구로 복원했습니다.": "The built-in template was restored to its original title and prompt.",
    "삭제 확인을 한 번 더 누르면 이 템플릿이 삭제됩니다.": "Press confirm deletion again to delete this template.",
    "템플릿을 삭제했습니다.": "Template deleted.",
    "입력창에 넣을 요청 문구가 없습니다.": "There is no prompt to insert.",
    "템플릿을 입력창에 불러왔습니다. 확인하거나 수정한 뒤 보내세요.": "The template was inserted into the composer. Review or edit it before sending.",
    "현재 사이트를 확인하지 못했습니다.": "Could not identify the current site.",
    "페이지에서 요소를 선택하세요": "Select an element on the page",
    "요소": "Element",
    "요소 선택 취소됨": "Element selection cancelled",
    "설정이 저장되었습니다.": "Settings saved.",
    "모든 변경 내용이 저장되었습니다.": "All changes have been saved.",
    "설정을 초기화했습니다.": "Settings reset.",
    "꺼짐": "Off",
    "연결 중": "Connecting",
    "다시 연결 중": "Reconnecting",
    "인증 중": "Authenticating",
    "페어링 필요": "Pairing required",
    "페어링 중": "Pairing",
    "연결됨": "Connected",
    "연결 오류": "Connection error",
    "외부 세션 사용 중": "External session active",
    "브리지가 표시한 Extension setup 값을 다시 붙여넣어 주세요.": "Paste the Extension setup value shown by the bridge again.",
    "인증된 로컬 브리지와 연결되어 있습니다.": "Connected to an authenticated local bridge.",
    "외부 개발 도구가 브라우저 작업을 요청했습니다.": "An external developer tool requested browser actions.",
    "현재 화면": "Current page",
    "MCP 개발 도구를 연결하고 현재 탭을 공유했습니다.": "Connected the MCP developer tool and shared the current tab.",
    "Bridge 연결을 해제했습니다.": "Disconnected the bridge.",
    "이 Bridge 연결 권한을 폐기했습니다.": "Revoked this bridge connection permission.",
    "현재 탭을 MCP 개발 도구에 공유했습니다.": "Shared the current tab with the MCP developer tool.",
    "Bridge 연결에 실패했습니다.": "Bridge connection failed.",
    "저장된 연결 권한이 없습니다. 새 Extension setup 값을 붙여넣어 주세요.": "No saved connection permission was found. Paste a new Extension setup value.",
    "Bridge 연결 시간이 초과되었습니다. 로컬 MCP 서버가 실행 중인지 확인해 주세요.": "The bridge connection timed out. Check that the local MCP server is running.",
    "현재 탭을 안정적으로 관찰하는 데 필요한 사이트 권한이 허용되지 않았습니다.": "The site permission required to observe the current tab reliably was not granted.",
    "외부 개발 도구에서 현재 탭을 분리했습니다.": "Detached the current tab from the external developer tool.",
    "승인된 액션의 대상 사이트 권한이 허용되지 않아 실행하지 않았습니다.": "The approved action was not run because permission for the target site was not granted.",
    "최신 화면을 다시 확인한 뒤 실행 중입니다.": "Rechecking the latest page before execution.",
    "외부 개발 도구의 승인된 브라우저 작업을 실행하고 결과를 다시 관찰했습니다.": "Ran the approved browser actions from the external developer tool and observed the result.",
    "외부 개발 도구의 브라우저 작업 요청을 거부했습니다.": "Rejected the browser action request from the external developer tool.",
    "Extension setup JSON이 올바르지 않습니다.": "The Extension setup JSON is invalid.",
    "Extension setup JSON은 객체여야 합니다.": "The Extension setup JSON must be an object.",
    "현재 탭 확인 실패": "Could not check current tab",
    "제목 없음": "Untitled",
    "MCP 서버 접근 권한이 허용되지 않았습니다.": "Permission to access the MCP server was not granted.",
    "MCP가 꺼져 있습니다.": "MCP is disabled.",
    "MCP 인증 방식을 OAuth 2.1 PKCE로 선택해 주세요.": "Select OAuth 2.1 PKCE as the MCP authentication method.",
    "유효한 MCP endpoint를 입력해 주세요.": "Enter a valid MCP endpoint.",
    "MCP OAuth에 필요한 identity/site 권한이 허용되지 않았습니다.": "The identity/site permissions required for MCP OAuth were not granted.",
    "MCP OAuth 서버 정보를 확인하는 중입니다.": "Checking the MCP OAuth server.",
    "OAuth authorization/token endpoint 접근 권한이 허용되지 않았습니다.": "Permission to access the OAuth authorization/token endpoint was not granted.",
    "브라우저에서 MCP OAuth 승인을 완료해 주세요.": "Complete MCP OAuth authorization in the browser.",
    "MCP OAuth 연결이 완료되었습니다.": "MCP OAuth connection completed.",
    "MCP OAuth 연결을 해제했습니다.": "Disconnected MCP OAuth.",
    "JSON 객체 형식으로 입력해 주세요.": "Enter a JSON object.",
    "대화를 비웠습니다.": "Conversation cleared.",
    "오류": "Error",
    "페이지 작업": "Page action",
    "실행 결과를 확인하지 못했습니다.": "Could not verify the execution result.",
    "도구 결과를 확인하지 못했습니다.": "Could not verify the tool result.",
    "페이지 작업 일부를 실행하지 못했습니다.": "Some page actions could not be completed.",
    "외부 도구 일부를 실행하지 못했습니다.": "Some external tools could not be completed.",
    "화면 변화 확인 중": "Checking page changes",
    "도구 결과를 다음 턴에서 검증": "Verify tool results on the next turn",
    "관련 요소 검색": "Search related elements",
    "완료 판단": "Completion decision",
    "추가 정보 필요": "More information required",
    "진행 불가 판단": "Cannot proceed",
    "답변 준비": "Preparing response",
    "삽입 프레임 권한이 허용되지 않아 해당 프레임은 관찰과 제어에서 제외됩니다.": "An embedded frame was excluded from observation and control because its permission was not granted.",
    "업로드할 파일이 선택되지 않아 실행을 취소했습니다.": "Execution was cancelled because no file was selected for upload.",
    "선택한 파일의 합계가 안전 전송 한도 20MB를 초과합니다.": "The selected files exceed the 20 MB safe transfer limit.",
    "알 수 없는 오류가 발생했습니다.": "An unknown error occurred.",
    "AI 판단 응답을 사용자용 형식으로 변환하지 못했습니다. 페이지는 변경하지 않았습니다.": "The AI decision could not be converted to a user-facing format. The page was not changed.",
    "외부 서비스 오류의 상세 응답을 사용자용 형식으로 변환하지 못했습니다.": "The external service error details could not be converted to a user-facing format.",
    "외부 서비스가 구조화된 오류 응답을 반환했습니다. 연결 설정과 진단 로그를 확인해 주세요.": "The external service returned a structured error. Check the connection settings and diagnostic logs.",
    "일반 웹 사이트에서 설정할 수 있습니다": "Available on normal websites",
    "작업 정보 없음": "No action details",
    "Extension setup 값에서 WebSocket endpoint를 찾지 못했습니다.": "No WebSocket endpoint was found in the Extension setup value.",
    "Extension setup URL이 올바르지 않습니다.": "The Extension setup URL is invalid.",
    "Extension setup은 ws 또는 wss를 사용해야 합니다.": "Extension setup must use ws or wss.",
    "Extension setup은 로컬 loopback 주소여야 합니다.": "Extension setup must use a local loopback address.",
    "Extension setup endpoint는 로컬 포트의 /extension 경로여야 합니다.": "The Extension setup endpoint must use the /extension path on a local port.",
    "Extension setup에 인증정보나 query를 넣을 수 없습니다.": "Extension setup cannot contain credentials or a query.",
    "Extension setup fragment가 올바르지 않습니다.": "The Extension setup fragment is invalid.",
    "Extension setup의 페어링 코드가 서로 일치하지 않습니다.": "The Extension setup pairing codes do not match.",
    "Extension setup의 일회용 페어링 코드가 올바르지 않습니다.": "The one-time Extension setup pairing code is invalid.",
    "브라우저 내부 페이지는 Chrome/Edge 정책상 화면 읽기와 조작을 허용하지 않습니다. 일반 웹 페이지에서 다시 시도해 주세요.": "Browser-internal pages cannot be read or controlled under Chrome/Edge policy. Try again on a normal web page.",
    "AI API 접근 권한이 허용되지 않았습니다.": "Permission to access the AI API was not granted.",
    "API 연결을 확인하는 중입니다.": "Checking the API connection.",
    "도구 확인 실패": "Could not load tools",
    "도구 없음": "No tools",
    "MCP 도구 목록을 확인하면 여기에 표시됩니다.": "Refresh the MCP tool list to show it here.",
    "실행 중...": "Running...",
    "MCP resources/prompts를 확인하는 중입니다.": "Checking MCP resources and prompts.",
    "리소스 없음": "No resources",
    "Resources를 확인하면 여기에 표시됩니다.": "Refresh resources to show them here.",
    "읽는 중...": "Reading...",
    "프롬프트 없음": "No prompts",
    "Prompts를 확인하면 여기에 표시됩니다.": "Refresh prompts to show them here.",
    "가져오는 중...": "Retrieving...",
    "진행 중인 작업을 완료하거나 중지한 뒤 새 요청을 보내 주세요.": "Complete or stop the current task before sending a new request.",
    "필요한 사이트 접근 권한이 허용되지 않아 작업을 시작하지 않았습니다.": "The task was not started because the required site permission was not granted.",
    "AI API Endpoint를 먼저 설정해 주세요.": "Configure the AI API endpoint first.",
    "AI API Endpoint는 http 또는 https URL이어야 합니다.": "The AI API endpoint must be an HTTP or HTTPS URL.",
    "AI API Endpoint URL 형식을 확인해 주세요.": "Check the AI API endpoint URL format.",
    "Custom JSON 형식에는 body template이 필요합니다.": "The Custom JSON format requires a body template.",
    "작업을 실행할 웹 탭을 확인하지 못했습니다.": "Could not identify the web tab for the task.",
    "에이전트 세션이 없습니다.": "There is no agent session.",
    "현재 요청의 범위와 완료 조건을 확인 중": "Resolving the request scope and completion criteria",
    "명시적 후속 요청으로 해석": "Interpreted as an explicit continuation",
    "새 요청으로 범위 고정": "Bound as a new request",
    "새 요청으로 안전하게 범위 고정": "Safely bound as a new request",
    "작업 흐름": "Task flow",
    "현재 화면을 읽는 중": "Reading the current page",
    "도구 실행 없음": "No tool execution",
    "페이지 조작 없음": "No page actions",
    "재확인 없음": "No verification",
    "진행 중": "In progress",
    "확인 필요": "Needs review",
    "중단": "Blocked",
    "건너뜀": "Skipped",
    "다음 행동을 찾지 못했습니다.": "No next action was found.",
    "안전 정책으로 중단": "Stopped by safety policy",
    "안전 정책으로 중단됨": "Stopped by safety policy",
    "실행 전 승인 대기": "Waiting for approval before execution",
    "승인 대기 중": "Waiting for approval",
    "중지되었습니다.": "Stopped.",
    "독립 verifier가 완료를 확인하지 못했습니다.": "The independent verifier could not confirm completion.",
    "독립 verifier가 화면 기반 답변의 근거를 확인하지 못했습니다.": "The independent verifier could not confirm evidence for the page-grounded answer.",
    "AI 응답을 안전한 실행 계획으로 변환하지 못해 페이지를 추가로 변경하지 않았습니다. 잠시 후 다시 요청해 주세요.": "The AI response could not be converted into a safe execution plan, so no further page changes were made. Try again shortly.",
    "판단 계약 검증 실패": "Decision contract validation failed",
    "같은 요소 검색이 반복되었지만 현재 화면에서 실행할 대상을 특정하지 못했습니다.": "Repeated element searches could not identify an actionable target on the current page.",
    "한 턴의 관련 요소 검색 한도 안에서 실행할 대상을 특정하지 못했습니다.": "No actionable target was found within the per-turn related-element search limit.",
    "관련 요소 검색이 더 이상 진행되지 않음": "Related-element search could not progress",
    "검색 결과 없음 · 일반 요소 탐색으로 전환": "No search results · switching to general element discovery",
    "같은 화면에서 같은 실행 계획이 반복되어 안전하게 중단했습니다. 목표를 더 구체화하거나 페이지 상태를 바꾼 뒤 다시 시도해 주세요.": "The same execution plan repeated on an unchanged page, so the task was stopped safely. Make the goal more specific or change the page state, then try again.",
    "AI 판단 응답 형식을 확인해야 합니다.": "The AI decision response format needs attention.",
    "판단 응답 형식 오류": "Decision response format error",
    "사용자에게 표시할 message에는 내부 판단 JSON을 넣을 수 없습니다.": "A user-facing message cannot contain internal decision JSON.",
    "독립 verifier가 완료 근거를 확인 중": "Independent verifier is checking completion evidence",
    "독립 완료 검증을 다시 실행해야 합니다.": "Independent completion verification must be run again.",
    "완료 검증 실패": "Completion verification failed",
    "독립 verifier가 최종 답변과 화면 근거를 확인 중": "Independent verifier is checking the final answer against page evidence",
    "현재 화면 근거에 맞춘 답변을 다시 생성해야 합니다.": "The answer must be regenerated from current page evidence.",
    "답변 근거 검증 실패": "Answer grounding verification failed",
    "독립 정책 판정이 설정에서 비활성화되어 있습니다.": "Independent policy evaluation is disabled in settings.",
    "정책 판정 형식이 불완전하여 사용자 승인이 필요합니다.": "The policy decision is incomplete, so user approval is required.",
    "정책 판정을 완료하지 못했습니다.": "The policy evaluation could not be completed.",
    "정책 판정 실패로 인해 fail-closed 승인이 필요합니다.": "Fail-closed approval is required because policy evaluation failed.",
    "다음 액션을 준비했습니다.": "The next action is ready.",
    "조금 더 구체적으로 알려주세요.": "Please provide a little more detail.",
    "완료되었습니다.": "Completed.",
    "현재 상태에서는 진행할 수 없습니다.": "Cannot proceed from the current state.",
    "현재 화면의 관련 컨트롤": "Related controls on the current page",
    "같은 상태 변경 작업이 이 요청에서 이미 성공해 반복 실행을 중단했습니다. 현재 화면의 결과를 확인한 뒤, 추가 반복이 필요하면 횟수나 종료 조건을 새 요청으로 지정해 주세요.": "The same state-changing action already succeeded in this request, so repeated execution was stopped. Check the current result and specify a count or stopping condition in a new request if more repetitions are needed.",
    "턴 의도의 반복 실행 한도에 도달함": "Turn-intent repetition limit reached",
    "파일 선택 취소 또는 실패": "File selection cancelled or failed",
    "계획 실행에 필요한 사이트 권한이 허용되지 않았습니다.": "The site permission required to execute the plan was not granted.",
    "권한 승인 필요": "Permission required",
    "승인 후 문서가 새로 로드되어 기존 요소 참조를 폐기했습니다.": "The document reloaded after approval, so the previous element references were discarded.",
    "현재 화면에 결합된 스크린샷을 확보하지 못했습니다.": "Could not obtain a screenshot bound to the current page.",
    "화면 좌표 대상 surface가 현재 관찰에 없습니다.": "The visual target surface is not present in the current observation.",
    "화면 좌표 대상을 독립적으로 확인 중": "Independently verifying the visual target",
    "화면 좌표 대상이 명확하게 확인되지 않았습니다.": "The visual target could not be identified clearly.",
    "화면 좌표 검증 실패": "Visual target verification failed",
    "화면 좌표 확인됨": "Visual target verified",
    "필요한 도구 없음": "No tools required",
    "필요한 페이지 조작 없음": "No page actions required",
    "마지막 변경 되돌리는 중": "Undoing the last change",
    "되돌릴 수 있는 변경이 없습니다.": "There are no changes to undo.",
    "사용자가 취소": "Cancelled by user",
    "대기 중인 액션을 취소했습니다.": "Cancelled the pending actions.",
    "취소됨": "Cancelled",
    "사용자가 중지": "Stopped by user",
    "중지됨": "Stopped",
    "중단됨": "Blocked",
    "현재 페이지 컨텍스트가 없습니다.": "Current page context is unavailable.",
    "독립 정책 판정이 실행을 차단했습니다.": "Independent policy evaluation blocked execution.",
    "MCP가 꺼져 있어 MCP 도구를 실행할 수 없습니다.": "MCP tools cannot run because MCP is disabled.",
    "사용 가능한 MCP 도구가 없습니다.": "No MCP tools are available.",
    "DOM 또는 스크롤 위치가 캡처 중 바뀌어 이전 스크린샷을 사용하지 않았습니다.": "The previous screenshot was discarded because the DOM or scroll position changed during capture.",
    "현재 화면을 읽는 중입니다.": "Reading the current page.",
    "컨텍스트를 갱신했습니다.": "Context refreshed.",
    "페이지": "Page",
    "텍스트": "Text",
    "수집 시간": "Collection time",
    "프레임": "Frames",
    "내부 스크롤": "Nested scrolling",
    "시각 surface": "Visual surfaces",
    "자동화 제약": "Automation constraints",
    "선택": "Selection",
    "선택 요소": "Selected element",
    "로그": "Logs",
    "AI 요청": "AI requests",
    "AI 토큰": "AI tokens",
    "아직 읽지 않음": "Not read yet",
    "없음": "None",
    "공급자 미제공": "Not provided by provider",
    "현재 컨텍스트": "Current context",
    "아직 수집된 컨텍스트가 없습니다.": "No context has been collected yet.",
    "컨텍스트를 복사했습니다.": "Context copied.",
    "내보낼 대화가 없습니다.": "There is no conversation to export.",
    "Markdown을 복사했습니다.": "Markdown copied.",
    "JSON 저장 완료": "JSON saved",
    "CSV 저장 완료": "CSV saved",
    "Markdown 저장 완료": "Markdown saved",
    "액션을 실행할 준비가 되었습니다.": "Actions are ready to run.",
    "승인 미리보기를 캡처하는 동안 화면이 바뀌어 이전 좌표 이미지를 표시하지 않았습니다.": "The previous target image was not shown because the page changed while the approval preview was captured.",
    "외부 도구 · 파괴적 동작 가능": "External tool · potentially destructive",
    "외부 도구 · 읽기 전용": "External tool · read-only",
    "외부 도구 호출": "External tool call",
    "화면 대상": "Visual target",
    "세부 정보 없음": "No details",
    "대상: 현재 화면 기준": "Target: current page",
    "설명 없음": "No description",
    "실행 직전 최신 스크린샷과 독립 verifier로 다시 확인": "Recheck with a fresh screenshot and independent verifier immediately before execution",
    "파일 전송": "File transfer",
    "화면 좌표 · 재검증": "Visual coordinates · reverify",
    "브라우저 작업": "Browser action",
    "민감 입력": "Sensitive input",
    "변경": "Change",
    "낮음": "Low",
    "AI API 요청 시간이 초과되었습니다.": "The AI API request timed out.",
    "AI API 요청이 취소되었습니다.": "The AI API request was cancelled."
  });

  const ENGLISH_PATTERNS = Object.freeze([
    [/^현재 사이드 패널 위치: (.+)$/u, ([, side]) => `Current side panel position: ${translateKnownText(side, "en")}`],
    [/^(.+) 사용 중$/u, ([, value]) => `${value} enabled`],
    [/^(.+) · 수정됨$/u, ([, title]) => `${title} · modified`],
    [/^템플릿은 최대 ([0-9,]+)개까지 저장할 수 있습니다\. 기존 템플릿을 삭제한 뒤 다시 시도해 주세요\.$/u, ([, count]) => `You can save up to ${count} templates. Delete an existing template and try again.`],
    [/^(.+) 사이트별 설정$/u, ([, site]) => `Per-site settings for ${site}`],
    [/^현재 적용값 · (자동형|승인형) · 스크린샷 (사용|사용 안 함) · MCP (사용|사용 안 함)$/u, ([, mode, screenshot, mcp]) => `Effective settings · ${translateKnownText(mode, "en")} · Screenshots ${translateKnownText(screenshot, "en")} · MCP ${translateKnownText(mcp, "en")}`],
    [/^(.+)에만 적용할 설정을 저장했습니다\.$/u, ([, site]) => `Saved settings that apply only to ${site}.`],
    [/^(.+)는 다시 기본 설정을 따릅니다\.$/u, ([, site]) => `${site} now follows the default settings again.`],
    [/^요소 선택됨: (.+)$/u, ([, value]) => `Element selected: ${value}`],
    [/^선택: (.+)$/u, ([, value]) => `Selected: ${value}`],
    [/^ · ([0-9,]+)개 도구$/u, ([, count]) => ` · ${count} tools`],
    [/^MCP 켜짐 · ([0-9,]+)개 도구$/u, ([, count]) => `MCP on · ${count} tools`],
    [/^외부 승인 ([0-9,]+)건$/u, ([, count]) => `${count} external approvals`],
    [/^([0-9,]+)건$/u, ([, count]) => `${count} requests`],
    [/^([0-9,]+)개 작업$/u, ([, count]) => `${count} actions`],
    [/^([0-9,]+)개 실행 항목 준비$/u, ([, count]) => `${count} execution items ready`],
    [/^MCP 도구 ([0-9,]+)개를 확인했습니다\.$/u, ([, count]) => `Found ${count} MCP tools.`],
    [/^([0-9]+)\. (.+) · ([0-9,]+)개$/u, ([, index, actions, count]) => `${index}. ${actions} · ${count} actions`],
    [/^OAuth 연결됨(?: · (.+))?$/u, ([, scope]) => scope ? `OAuth connected · ${scope}` : "OAuth connected"],
    [/^승인 사유: (.+)$/u, ([, value]) => `Approval reason: ${value}`],
    [/^주의: (.+)$/u, ([, value]) => `Caution: ${value}`],
    [/^승인 만료: (.+)$/u, ([, value]) => `Approval expires: ${value}`],
    [/^외부 요청은 화면이 변경되어 실행하지 않았습니다\.(.*)$/u, ([, detail]) => `The external request was not run because the page changed.${detail}`],
    [/^화면 갱신됨 · 텍스트 ([0-9,]+)자 · 요소 ([0-9,]+)개$/u, ([, chars, elements]) => `Page refreshed · ${chars} characters · ${elements} elements`],
    [/^API 응답 확인됨: (.+)$/u, ([, value]) => `API response received: ${value}`],
    [/^도구 ([0-9,]+)개$/u, ([, count]) => `${count} tools`],
    [/^(.+) 테스트 완료$/u, ([, tool]) => `${tool} test completed`],
    [/^리소스 ([0-9,]+)개, 프롬프트 ([0-9,]+)개를 확인했습니다\.$/u, ([, resources, prompts]) => `Found ${resources} resources and ${prompts} prompts.`],
    [/^리소스 ([0-9,]+)개$/u, ([, count]) => `${count} resources`],
    [/^프롬프트 ([0-9,]+)개$/u, ([, count]) => `${count} prompts`],
    [/^HTTP (.+) 응답에 사용할 수 있는 출력이 없습니다\.$/u, ([, status]) => `The HTTP ${status} response contained no usable output.`],
    [/^AI API가 HTTP (.+) 오류를 반환했습니다\.$/u, ([, status]) => `The AI API returned an HTTP ${status} error.`],
    [/^최대 턴 ([0-9,]+)회에 도달했습니다\.$/u, ([, count]) => `Reached the maximum of ${count} turns.`],
    [/^([0-9,]+)번째 턴 · 화면 관찰 중$/u, ([, step]) => `Turn ${step} · observing page`],
    [/^([0-9,]+)번째 턴 화면 관찰 중$/u, ([, step]) => `Turn ${step} · observing page`],
    [/^텍스트 ([0-9,]+)자 · 요소 ([0-9,]+)개$/u, ([, chars, elements]) => `${chars} characters · ${elements} elements`],
    [/^([0-9,]+)번째 턴 · AI 판단 중$/u, ([, step]) => `Turn ${step} · AI decision in progress`],
    [/^([0-9,]+)번째 턴 판단 중$/u, ([, step]) => `Turn ${step} · AI decision in progress`],
    [/^([0-9,]+)번째 턴 판단 교정 중$/u, ([, step]) => `Turn ${step} · repairing AI decision`],
    [/^([0-9,]+)번째 턴 근거 보완 계획 중$/u, ([, step]) => `Turn ${step} · planning additional evidence`],
    [/^([0-9,]+)번째 턴 화면 근거에 맞게 답변 교정 중$/u, ([, step]) => `Turn ${step} · grounding answer in page evidence`],
    [/^관련 요소 검색 중 · (.+)$/u, ([, detail]) => `Searching related elements · ${detail}`],
    [/^요소 ([0-9,]+)개 확인 · 다음 묶음 탐색 중$/u, ([, count]) => `${count} elements checked · searching the next window`],
    [/^관찰과 판단이 ([0-9,]+)회 연속 반복됨$/u, ([, count]) => `Observation and decision repeated ${count} consecutive times`],
    [/^AI 판단 응답을 구조화된 객체로 해석하지 못했습니다: (.+)$/u, ([, detail]) => `Could not parse the AI decision as a structured object: ${detail}`],
    [/^완료 verifier 호출 실패: (.+)$/u, ([, detail]) => `Completion verifier call failed: ${detail}`],
    [/^답변 근거 verifier 호출 실패: (.+)$/u, ([, detail]) => `Answer-grounding verifier call failed: ${detail}`],
    [/^([0-9,]+)번째 턴 실행 정책 확인 중$/u, ([, step]) => `Turn ${step} · checking execution policy`],
    [/^독립 정책 판정 실패: (.+)$/u, ([, detail]) => `Independent policy evaluation failed: ${detail}`],
    [/^현재 화면에서 관련 요소를 검색합니다: (.+)$/u, ([, detail]) => `Searching the current page for related elements: ${detail}`],
    [/^역할 (.+)$/u, ([, roles]) => `Roles ${roles}`],
    [/^주변 “(.+)”$/u, ([, text]) => `Near “${text}”`],
    [/^승인 대기 중 페이지 상태가 바뀌어 기존 계획을 실행하지 않고 다시 계획합니다\.\n([\s\S]+)$/u, ([, details]) => `The page changed while approval was pending, so the previous plan will not run and will be replanned.\n${details}`],
    [/^화면 좌표 대상을 현재 스크린샷에서 독립적으로 확인하지 못해 실행하지 않고 다시 계획합니다\.\n([\s\S]+)$/u, ([, details]) => `The visual target could not be independently verified in the current screenshot, so it will not run and will be replanned.\n${details}`],
    [/^관찰한 페이지가 변경되었습니다: (.+) → (.+)$/u, ([, before, after]) => `The observed page changed: ${before} → ${after}`],
    [/^액션 사전조건이 없습니다: (.+)$/u, ([, action]) => `Action preconditions are missing: ${action}`],
    [/^페이지 URL이 변경되었습니다: (.+) → (.+)$/u, ([, before, after]) => `The page URL changed: ${before} → ${after}`],
    [/^액션 대상 문서가 교체되었습니다: (.+)$/u, ([, action]) => `The action target document was replaced: ${action}`],
    [/^화면 좌표 액션을 검증할 최신 스크린샷이 없습니다: (.+)$/u, ([, action]) => `No fresh screenshot is available to verify the visual action: ${action}`],
    [/^화면 좌표 액션을 계획한 뒤 화면 구조나 위치가 변경되었습니다: (.+)$/u, ([, action]) => `The page structure or position changed after the visual action was planned: ${action}`],
    [/^브라우저 탭 상태가 변경되었습니다: (.+)$/u, ([, tab]) => `The browser tab state changed: ${tab}`],
    [/^다운로드 상태를 더 이상 확인할 수 없습니다: (.+)$/u, ([, download]) => `The download state can no longer be checked: ${download}`],
    [/^액션 대상이 변경되었거나 사라졌습니다: (.+)$/u, ([, action]) => `The action target changed or disappeared: ${action}`],
    [/^화면 좌표 verifier 호출 실패: (.+)$/u, ([, detail]) => `Visual target verifier call failed: ${detail}`],
    [/^([0-9,]+)번째 턴 · MCP 도구 실행 중$/u, ([, step]) => `Turn ${step} · running MCP tools`],
    [/^([0-9,]+)개 도구 실행 중$/u, ([, count]) => `Running ${count} tools`],
    [/^(.+) 실패$/u, ([, name]) => `${name} failed`],
    [/^([0-9,]+)개 도구 완료$/u, ([, count]) => `${count} tools completed`],
    [/^지원하지 않는 MCP capability입니다: (.+)$/u, ([, capability]) => `Unsupported MCP capability: ${capability}`],
    [/^([0-9,]+)번째 턴 · 브라우저 액션 실행 중$/u, ([, step]) => `Turn ${step} · running browser actions`],
    [/^([0-9,]+)개 액션 실행 중$/u, ([, count]) => `Running ${count} actions`],
    [/^([0-9,]+)개 액션 완료$/u, ([, count]) => `${count} actions completed`],
    [/^턴당 액션 수를 ([0-9,]+)개로 제한했습니다\.$/u, ([, count]) => `Actions per turn were limited to ${count}.`],
    [/^턴당 MCP 도구 호출 수를 ([0-9,]+)개로 제한했습니다\.$/u, ([, count]) => `MCP tool calls per turn were limited to ${count}.`],
    [/^사용 가능한 MCP 도구가 아닙니다: (.+)$/u, ([, tool]) => `This MCP tool is not available: ${tool}`],
    [/^MCP 도구 목록을 확인하지 못했습니다: (.+)$/u, ([, detail]) => `Could not load the MCP tool list: ${detail}`],
    [/^허용 목록에 없는 MCP 도구입니다: (.+)$/u, ([, tool]) => `This MCP tool is not in the allowlist: ${tool}`],
    [/^MCP 도구 실행 승인 필요: (.+)$/u, ([, tool]) => `Approval required to run MCP tool: ${tool}`],
    [/^파괴적 동작으로 표시된 MCP 도구입니다: (.+)$/u, ([, tool]) => `MCP tool marked as destructive: ${tool}`],
    [/^외부 시스템과 통신할 수 있는 MCP 도구입니다: (.+)$/u, ([, tool]) => `MCP tool can communicate with an external system: ${tool}`],
    [/^지원하지 않는 액션입니다: (.+)$/u, ([, action]) => `Unsupported action: ${action}`],
    [/^자동 실행 전 확인이 필요한 액션입니다: (.+)$/u, ([, action]) => `Action requires confirmation before automatic execution: ${action}`],
    [/^민감 입력으로 판단되어 중단했습니다: (.+)$/u, ([, target]) => `Stopped because the input was identified as sensitive: ${target}`],
    [/^([0-9,]+)자$/u, ([, count]) => `${count} characters`],
    [/^([0-9,]+)개 확인 · ([0-9,]+)개 권한 필요$/u, ([, verified, inaccessible]) => `${verified} verified · ${inaccessible} need permission`],
    [/^([0-9,]+)개 도구$/u, ([, count]) => `${count} tools`],
    [/^([0-9,]+)개$/u, ([, count]) => `${count}`],
    [/^([0-9,]+)개 · 실패 ([0-9,]+)개$/u, ([, requests, failures]) => `${requests} · ${failures} failed`],
    [/^([0-9,]+)개 메시지 · AI 요청 ([0-9,]+)개$/u, ([, messages, requests]) => `${messages} messages · ${requests} AI requests`],
    [/^승인 필요: (.+)$/u, ([, detail]) => `Approval required: ${detail}`],
    [/^계획: (.+)$/u, ([, detail]) => `Plan: ${detail}`],
    [/^진행: (.+)$/u, ([, detail]) => `Progress: ${detail}`],
    [/^성공 기준: (.+)$/u, ([, detail]) => `Success criteria: ${detail}`],
    [/^대상: (.+)$/u, ([, value]) => `Target: ${value}`],
    [/^링크: (.+)$/u, ([, value]) => `Link: ${value}`],
    [/^요소: (.+)$/u, ([, value]) => `Element: ${value}`],
    [/^이동: (.+)$/u, ([, value]) => `Navigate: ${value}`],
    [/^탭: (.+)$/u, ([, value]) => `Tab: ${value}`],
    [/^다운로드: (.+)$/u, ([, value]) => `Download: ${value}`],
    [/^조건: (.+)$/u, ([, value]) => `Condition: ${value}`],
    [/^입력값: (.+)$/u, ([, value]) => `Input: ${value}`],
    [/^사용자가 직접 선택할 파일(들)?(.*)$/u, ([, plural, detail]) => `File${plural ? "s" : ""} selected directly by the user${detail}`],
    [/^화면 대상: (.+)$/u, ([, value]) => `Visual target: ${value}`],
    [/^페이지 작업 일부를 실행하지 못했습니다\.\n([\s\S]+)$/u, ([, details]) => `Some page actions could not be completed.\n${details}`],
    [/^외부 도구 일부를 실행하지 못했습니다\.\n([\s\S]+)$/u, ([, details]) => `Some external tools could not be completed.\n${details}`],
    [/^([0-9,]+)개 실패 · 다음 턴에서 재계획$/u, ([, count]) => `${count} failed · replan on the next turn`],
    [/^([0-9,]+)\/([0-9,]+)개 변화 확인$/u, ([, changed, total]) => `${changed}/${total} changes verified`],
    [/^파일을 읽지 못했습니다: (.+)$/u, ([, file]) => `Could not read file: ${file}`],
    [/^관련 요소 검색 · (.+)$/u, ([, detail]) => `Search related elements · ${detail}`]
  ]);

  const originalText = new WeakMap();
  const originalAttributes = new WeakMap();
  let currentLocale = "ko";
  let observer = null;

  function normalizePreference(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return SUPPORTED_PREFERENCES.has(normalized) ? normalized : "auto";
  }

  function resolveLocale(preference = "auto", languages) {
    const normalized = normalizePreference(preference);
    if (normalized !== "auto") {
      return normalized;
    }
    const candidates = Array.isArray(languages) && languages.length
      ? languages
      : [
          ...(Array.isArray(global.navigator?.languages) ? global.navigator.languages : []),
          global.navigator?.language
        ];
    const preferredLanguage = candidates.find((language) => String(language || "").trim());
    return /^ko(?:-|$)/iu.test(String(preferredLanguage || "")) ? "ko" : "en";
  }

  function splitWhitespace(value) {
    const text = String(value ?? "");
    const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/u);
    return match ? { leading: match[1], content: match[2], trailing: match[3] } : {
      leading: "",
      content: text,
      trailing: ""
    };
  }

  function translateKnownText(value, locale = currentLocale) {
    const text = String(value ?? "");
    if (locale !== "en" || !text) {
      return text;
    }
    const { leading, content, trailing } = splitWhitespace(text);
    const exact = ENGLISH[content];
    if (exact !== undefined) {
      return `${leading}${exact}${trailing}`;
    }
    for (const [pattern, format] of ENGLISH_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        return `${leading}${format(match)}${trailing}`;
      }
    }
    return text;
  }

  function hasTranslation(value) {
    const { content } = splitWhitespace(value);
    return Object.hasOwn(ENGLISH, content) || ENGLISH_PATTERNS.some(([pattern]) => pattern.test(content));
  }

  function isIgnored(node) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    return Boolean(element?.closest?.(IGNORED_CONTENT_SELECTOR));
  }

  function translateTextNode(node, locale, forceSource = false) {
    if (node.nodeType !== 3 || !node.nodeValue || isIgnored(node)) {
      return;
    }
    const current = node.nodeValue;
    let source = originalText.get(node);
    if (source === undefined || (!forceSource && current !== source && current !== translateKnownText(source, locale))) {
      source = current;
      originalText.set(node, source);
    }
    const translated = translateKnownText(source, locale);
    if (current !== translated) {
      node.nodeValue = translated;
    }
  }

  function translateElementAttributes(element, locale, forceSource = false) {
    if (element.nodeType !== 1 || isIgnored(element)) {
      return;
    }
    let sourceMap = originalAttributes.get(element);
    if (!sourceMap) {
      sourceMap = new Map();
      originalAttributes.set(element, sourceMap);
    }
    for (const attribute of TRANSLATABLE_ATTRIBUTES) {
      if (!element.hasAttribute(attribute)) {
        continue;
      }
      const current = element.getAttribute(attribute) || "";
      let source = sourceMap.get(attribute);
      if (source === undefined || (!forceSource && current !== source && current !== translateKnownText(source, locale))) {
        source = current;
        sourceMap.set(attribute, source);
      }
      const translated = translateKnownText(source, locale);
      if (current !== translated) {
        element.setAttribute(attribute, translated);
      }
    }
  }

  function translateTree(root, locale, forceSource = false) {
    if (!root) {
      return;
    }
    if (root.nodeType === 3) {
      translateTextNode(root, locale, forceSource);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) {
      return;
    }
    if (root.nodeType === 1) {
      translateElementAttributes(root, locale, forceSource);
    }
    const walker = root.ownerDocument?.createTreeWalker?.(
      root,
      global.NodeFilter?.SHOW_ELEMENT | global.NodeFilter?.SHOW_TEXT
    );
    if (!walker) {
      return;
    }
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === 1) {
        translateElementAttributes(node, locale, forceSource);
      } else {
        translateTextNode(node, locale, forceSource);
      }
      node = walker.nextNode();
    }
  }

  function setElementText(element, value, locale = currentLocale) {
    if (!element) {
      return "";
    }
    const source = String(value ?? "");
    let textNode = element.childNodes.length === 1 && element.firstChild?.nodeType === 3
      ? element.firstChild
      : null;
    if (!textNode) {
      textNode = element.ownerDocument.createTextNode("");
      element.replaceChildren(textNode);
    }
    originalText.set(textNode, source);
    const translated = translateKnownText(source, locale);
    textNode.nodeValue = translated;
    return translated;
  }

  function setElementAttribute(element, attribute, value, locale = currentLocale) {
    if (!element || !TRANSLATABLE_ATTRIBUTES.includes(attribute)) {
      return "";
    }
    const source = String(value ?? "");
    let sourceMap = originalAttributes.get(element);
    if (!sourceMap) {
      sourceMap = new Map();
      originalAttributes.set(element, sourceMap);
    }
    sourceMap.set(attribute, source);
    const translated = translateKnownText(source, locale);
    element.setAttribute(attribute, translated);
    return translated;
  }

  function startObserver(document) {
    if (observer || !global.MutationObserver || !document?.documentElement) {
      return;
    }
    observer = new global.MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") {
          translateTextNode(record.target, currentLocale);
        } else if (record.type === "attributes") {
          translateElementAttributes(record.target, currentLocale);
        } else {
          for (const node of record.addedNodes) {
            translateTree(node, currentLocale);
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATABLE_ATTRIBUTES
    });
  }

  function applyDocument(document, preference = "auto", languages) {
    currentLocale = resolveLocale(preference, languages);
    if (!document?.documentElement) {
      return currentLocale;
    }
    document.documentElement.lang = currentLocale;
    translateTree(document.documentElement, currentLocale, true);
    startObserver(document);
    document.dispatchEvent?.(new global.CustomEvent("ui-language-changed", {
      detail: { locale: currentLocale, preference: normalizePreference(preference) }
    }));
    return currentLocale;
  }

  global.WebUiI18n = Object.freeze({
    applyDocument,
    hasTranslation,
    normalizePreference,
    resolveLocale,
    setElementAttribute,
    setElementText,
    translateKnownText
  });
})(globalThis);

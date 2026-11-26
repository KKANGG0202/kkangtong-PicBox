import { updateSentNote } from './sentnote.js';
// "관리 > 설정": all PicBox options live inside the gallery window.
import { getSettings, saveSettings } from './settings.js';
import { applyFold } from './fold.js';
import { clearThumbs } from './thumbs.js';
import { syncLongPressClass } from './longpress.js';
import { syncInputButton, buttonMode } from './inputbutton.js';

export function renderOptions(container) {
    const settings = getSettings();
    container.innerHTML = `
        <div class="pbx-options">
            <section>
                <h4><i class="fa-solid fa-compress"></i> 채팅 속 그림 접기</h4>
                <label class="pbx-check-label"><input type="checkbox" data-key="foldEnabled"><span>오래된 그림 접기</span></label>
                <label class="pbx-opt-row">
                    <span>그림을 펼쳐둘 최근 메시지 수</span>
                    <span class="pbx-stepper">
                        <button class="pbx-btn pbx-icon" data-step="-1" title="줄이기"><i class="fa-solid fa-minus"></i></button>
                        <b class="pbx-keep"></b>
                        <button class="pbx-btn pbx-icon" data-step="1" title="늘리기"><i class="fa-solid fa-plus"></i></button>
                    </span>
                </label>
                <label class="pbx-check-label"><input type="checkbox" data-key="foldMobileOnly"><span>휴대폰에서만 접기</span></label>
                <small>그림이 붙은 메시지만 세요. 예를 들어 3이면 그림 있는 최근 메시지 3개는 그대로 보이고, 그보다 오래된 그림은 "그림 보기" 버튼으로 접혀서 불러오지 않아요. 채팅 파일은 바뀌지 않아요.</small>
            </section>
            <section>
                <h4><i class="fa-solid fa-hand-pointer"></i> 채팅 그림 길게 누르기</h4>
                <label class="pbx-check-label"><input type="checkbox" data-key="longPressViewer"><span>길게 누르면 픽박스 뷰어로 보기</span></label>
                <small>그냥 누르면 실리 기본 확대 그대로예요. 길게 누르거나(폰) 우클릭하면(PC) 프롬프트·즐겨찾기·삭제가 있는 픽박스 뷰어가 열려요.</small>
            </section>
            <section>
                <h4><i class="fa-solid fa-palette"></i> 픽박스로 그리기</h4>
                <div class="pbx-opt-stack"><span>📷 버튼 위치</span>
                    <span class="pbx-chips pbx-btnmode">
                        <button class="pbx-chip" data-mode="input">입력창</button>
                        <button class="pbx-chip" data-mode="float-left">플로팅 왼쪽</button>
                        <button class="pbx-chip" data-mode="float-right">플로팅 오른쪽</button>
                        <button class="pbx-chip" data-mode="off">끄기</button>
                    </span>
                </div>
                <label class="pbx-check-label"><input type="checkbox" data-key="photoNote"><span>내가 보낸 사진 내용을 AI에게 알려주기</span></label>
                <small>"내 메시지로 보내기"를 할 때, 요청 내용과 장면·포즈·옷 같은 디테일을 화면에 안 보이는 메모로 같이 보내요. 외모 태그는 넣지 않아요.</small>
                <label class="pbx-check-label"><input type="checkbox" data-key="sentNote"><span>캐릭터가 톡으로 보낸 사진 내용도 AI에게 알려주기</span></label>
                <small>톡톡톡 스크립트로 톡하는 중에 오토픽이 붙인 사진만요(최근 6장). 채팅 기록은 안 바꾸고, AI가 읽는 내용에 사진에 보이는 것들을 메모로 같이 넣어요. 일반 장면 삽화는 그대로 둬요.</small>
                <label class="pbx-check-label"><input type="checkbox" data-key="drawAutoDelete"><span>채팅에 안 붙인 그림은 창 닫을 때 지우기</span></label>
                <small>꺼두면(기본) 그린 그림은 전부 폴더에 남아요. 채팅에 안 붙인 그림은 "관리 → 안 쓰는 그림"에서 볼 수 있어요.</small>
            </section>
            <section>
                <h4><i class="fa-solid fa-eraser"></i> 태그 자동 지우기</h4>
                <label class="pbx-check-label"><input type="checkbox" data-key="autoStripTags"><span>메시지를 보낼 때 이전 메시지의 &lt;autopic&gt; 태그 글 지우기</span></label>
                <small>꺼두면(기본) 그대로 두고, 필요할 때 "관리 → 태그 정리"에서 한 번에 지울 수 있어요. 그림은 그대로 남아요.</small>
            </section>
            <section>
                <h4><i class="fa-solid fa-file-zipper"></i> 내보내기</h4>
                <label class="pbx-check-label"><input type="checkbox" data-key="zipWithPrompts"><span>ZIP에 프롬프트(prompts.txt) 같이 넣기</span></label>
            </section>
            <section>
                <h4><i class="fa-solid fa-eraser"></i> 미리보기 캐시</h4>
                <button class="pbx-btn pbx-clear-thumbs"><i class="fa-solid fa-eraser"></i><span>미리보기 캐시 비우기</span></button>
                <small>갤러리용 작은 미리보기는 이 기기 브라우저에만 저장돼요. 원본 그림은 건드리지 않아요.</small>
            </section>
        </div>`;

    container.querySelectorAll('input[data-key]').forEach(input => {
        input.checked = !!settings[input.dataset.key];
        input.addEventListener('change', () => {
            settings[input.dataset.key] = input.checked;
            saveSettings();
            applyFold();
            syncLongPressClass();
            syncInputButton();
            updateSentNote();
        });
    });

    const modeChips = container.querySelectorAll('.pbx-btnmode .pbx-chip');
    const drawMode = () => {
        const mode = buttonMode();
        const current = mode === 'float' ? `float-${settings.floatSide === 'left' ? 'left' : 'right'}` : mode;
        modeChips.forEach(chip => chip.classList.toggle('active', chip.dataset.mode === current));
    };
    modeChips.forEach(chip => chip.addEventListener('click', () => {
        const [mode, side] = chip.dataset.mode.split('-');
        settings.inputButtonMode = mode;
        settings.inputButton = mode !== 'off';
        if (side) settings.floatSide = side;
        saveSettings();
        syncInputButton();
        drawMode();
    }));
    drawMode();

    const keep = container.querySelector('.pbx-keep');
    const drawKeep = () => { keep.textContent = String(settings.foldKeep); };
    container.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => {
        settings.foldKeep = Math.min(50, Math.max(0, (Number(settings.foldKeep) || 0) + Number(button.dataset.step)));
        drawKeep();
        saveSettings();
        applyFold();
    }));
    drawKeep();

    container.querySelector('.pbx-clear-thumbs').addEventListener('click', async () => {
        await clearThumbs();
        toastr.success('미리보기 캐시를 비웠어요.');
    });
    return () => {};
}

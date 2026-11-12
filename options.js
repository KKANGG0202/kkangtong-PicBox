// "관리 > 설정": all PicBox options live inside the gallery window.
import { getSettings, saveSettings } from './settings.js';
import { applyFold } from './fold.js';
import { clearThumbs } from './thumbs.js';

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
        });
    });

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

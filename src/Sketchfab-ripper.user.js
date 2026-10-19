// ==UserScript==
// @name         Sketchfab Ripper
// @namespace    https://github.com/anotherRandomPersonlol/SketchFabModelRipping
// @version      1.6.0
// @description  Download Sketchfab models as GLB or FBX: skeleton, recorded animation clips, PBR textures, vertex colours, morph targets
// @name:pl         Sketchfab Ripper
// @description:pl  Pobieraj modele ze Sketchfab jako GLB lub FBX: szkielet, nagrane klipy animacji, tekstury PBR, kolory wierzchołków, klucze kształtu
// @name:ru         Sketchfab Ripper
// @description:ru  Скачивайте модели со Sketchfab в GLB или FBX: скелет, записанные клипы анимации, PBR-текстуры, цвета вершин, ключи формы
// @name:ja         Sketchfab Ripper
// @description:ja  Sketchfab のモデルを GLB または FBX でダウンロード: スケルトン、録画したアニメーションクリップ、PBR テクスチャ、頂点カラー、シェイプキー
// @name:ko         Sketchfab Ripper
// @description:ko  Sketchfab 모델을 GLB 또는 FBX로 다운로드: 스켈레톤, 녹화한 애니메이션 클립, PBR 텍스처, 버텍스 컬러, 셰이프 키
// @name:es         Sketchfab Ripper
// @description:es  Descarga modelos de Sketchfab en GLB o FBX: esqueleto, clips de animación grabados, texturas PBR, colores de vértice, claves de forma
// @name:pt-BR      Sketchfab Ripper
// @description:pt-BR Baixe modelos do Sketchfab em GLB ou FBX: esqueleto, clipes de animação gravados, texturas PBR, cores de vértice, shape keys
// @name:de         Sketchfab Ripper
// @description:de  Sketchfab-Modelle als GLB oder FBX herunterladen: Skelett, aufgenommene Animationsclips, PBR-Texturen, Vertexfarben, Shape Keys
// @name:fr         Sketchfab Ripper
// @description:fr  Téléchargez des modèles Sketchfab en GLB ou FBX : squelette, clips d’animation enregistrés, textures PBR, couleurs de sommets, clés de forme
// @author       anotherRandomPersonlol
// @license      MIT
// @icon         https://raw.githubusercontent.com/anotherRandomPersonlol/Sketchfab-Ripper/main/docs/icon64.png
// @match        https://sketchfab.com/*
// @match        https://www.sketchfab.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.1.5/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/1.3.8/FileSaver.js
// @run-at       document-start
// @grant        unsafeWindow
// @homepageURL  https://github.com/anotherRandomPersonlol/Sketchfab-Ripper
// @supportURL   https://github.com/anotherRandomPersonlol/Sketchfab-Ripper/issues
// ==/UserScript==
// Based off Risk's extraction
(() => {
    'use strict';
    const window = unsafeWindow;

    window.allmodel            = window.allmodel            || [];
    window.animationRecording  = false;
    window.recordedFrames      = [];
    window.recordingStartTime  = 0;
    window.recordingRafId      = null;
    window.clips               = [];     // [{ name, uid, frames }]
    window.clipDefs            = [];     // [{ index, uid, name, duration }]
    window.clipRecording       = false;
    window.clipCancel          = false;  // set by the CANCEL button during RECORD ALL CLIPS
    window.autoRecordActive    = false;  // single-clip RECORD is running in auto (one full loop) mode
    window.staticPoseSnapshot  = null;   // snapshotFrame() taken with the viewer's "Static Pose" item selected
    window.clipStaticIdx       = -1;     // list item index of "Static Pose" (the item that activates no clip)
    window.clipProgress        = '';
    window._anyAnchorsMatched  = false;

    const saveimagecache2 = {};
    const objects         = {};
    let button_dw       = false;
    let _exporting      = false;   // true while downloadGLB runs (read by the recorders, which are defined first)

    const CONFIG = {
        MAX_RECORD_SECONDS: 12,
        AUTO_RELOAD_ON_FAILURE: true,
        MR_TEXTURE_FORMAT: 'jpeg',  // 'jpeg' (small) or 'png' (lossless)
        RECORD_FPS: 0,              // recording sample rate: 0 = every rendered frame, or 60 / 30 / 24 / 15
        CLIP_SETTLE_FRAMES: 2,      // rAF ticks to wait after seeking to a clip's start
        DEDUPE_STRICT_WORLD: false, // true: keep same-name meshes at different positions
        REST_POSE_SOURCE: 'clip0',  // joint rest pose: 'clip0' (first frame of first clip) or 'static' (viewer's Static Pose)
        TEXTURE_WAIT_SECONDS: 12,   // max wait at export for textures the viewer is still loading (0 = never wait)
        VERTEX_COLOR_SRGB: true,    // true: treat Sketchfab Color bytes as sRGB and write linear COLOR_0 (matches the viewer's look)
        EXPORT_SCALE: 1,            // uniform scale on the scene root (0.01 for models authored in centimetres)
        FLAT_MR_FROM_VIEWER: true,  // true: metalness/roughness of texture-less materials as the viewer shows them; false: neutral metal 0 / rough 0.5
        DROP_STRIP_SLIVERS: true,   // drop long, near-zero-width bridging triangles inside triangle strips (the "stripes")
        REDUCE_KEYS: true,          // drop keyframes that interpolation between the kept keys already reproduces (tolerance scales with the model size)
        KEEP_STILL_CLIPS: false,    // true: a clip in which no joint moves is exported as a pose clip (2 equal keys); false: such clips are left out
        DOUBLE_SIDED_AUTO: true,    // true: follow the viewer's Single Sided flag per material (cullFace != 0 -> single sided); false: use DOUBLE_SIDED for all
        LANGUAGE: 'auto',           // panel language: 'auto' (browser language) or a key of STRINGS ('en', 'pl')
        DOUBLE_SIDED: true          // true: mark every material doubleSided (matches Sketchfab's default, Single Sided OFF); untick for single-sided export
    };
    const CONFIG_KEY = 'ripper_config_v1';

    function loadConfig() {
        try {
            const saved = localStorage.getItem(CONFIG_KEY);
            if (!saved) return;
            const parsed = JSON.parse(saved);
            for (let k in parsed) {
                if (parsed.hasOwnProperty(k) && CONFIG.hasOwnProperty(k)
                    && typeof parsed[k] === typeof CONFIG[k]
                    && (typeof parsed[k] !== 'number' || isFinite(parsed[k]))) {
                    CONFIG[k] = parsed[k];
                }
            }
        } catch (e) { /* ignore */ }
    }

    function saveConfig() {
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(CONFIG)); }
        catch (e) { /* ignore */ }
    }

    loadConfig();

    // ====================================================================
    // UI text: English base + translations (the console log stays English)
    // ====================================================================
    // Keys used in code: i18n('key', {vars}) and i18nN('key', n, {vars}).
    // A plural entry is an object of Intl.PluralRules forms (one/few/many/other).
    // Check with: python3 tools/i18n/check_strings.py
    // @i18n-begin
    const STRINGS = {
        en: {
            settings: 'Settings',
            sec_download: 'Download',
            sec_animation: 'Animation',
            btn_glb: 'GLB',
            btn_fbx: 'FBX',
            tip_glb: 'Download a ZIP with a .glb file and its textures',
            tip_fbx: 'Download a ZIP with a binary .fbx file (FBX 7.4) and its textures',
            btn_rec_single: 'RECORD SINGLE CLIP',
            btn_rec_all: 'RECORD ALL CLIPS',
            btn_stop: 'STOP',
            btn_cancel: 'CANCEL',
            btn_cancelling: 'CANCELLING...',
            tip_no_clips: 'No animation clips found on this model',
            tip_one_clip: 'Only one clip: use RECORD SINGLE CLIP (records one full loop automatically)',
            tip_busy: 'Busy: wait for the current job to end',
            tip_busy_dl: 'Busy: wait for the recording or export to end',
            st_idle: 'idle',
            st_rec: '● REC',
            st_clips: '● CLIPS {p}',
            st_line: '{state} · meshes: {m} · frames: {f} · clips: {c}',
            st_rec_clips: ' (recorded {n})',
            st_no_anchors: '⚠ not connected to the viewer — reload the page',
            pr_recording: 'Recording {name}',
            pr_recording_manual: 'Recording (press STOP to end)',
            pr_seconds: '{t} / {d} s',
            pr_recorded_frames: { one: 'Recorded {n} frame', other: 'Recorded {n} frames' },
            pr_recorded_clips: { one: 'Recorded {n} clip', other: 'Recorded {n} clips' },
            pr_recording_failed: 'Recording failed',
            pr_recording_cancelled: 'Recording cancelled',
            pr_done: 'Done',
            pr_export_failed: 'Export failed',
            pr_see_console: 'see the console for details',
            stage_textures: 'Waiting for textures',
            stage_merge: 'Merging textures',
            stage_build: 'Building scene',
            stage_fbx: 'Writing FBX',
            stage_split: 'Splitting metal/rough maps',
            stage_zip: 'Packing ZIP',
            pr_no_textures: 'no textures',
            pr_all_captured: 'all {n} captured',
            pr_captured_wait: '{got}/{total} captured, waiting up to {s} s',
            pr_mr: 'metal/rough {d}/{n}',
            pr_no_mr: 'no metal/rough maps',
            pr_op: 'opacity {d}/{n}',
            pr_no_op: 'no opacity maps',
            pr_building: 'building meshes, materials and clips',
            fbx_nodes: 'nodes',
            fbx_materials: 'materials',
            fbx_geometry: 'geometry',
            fbx_geometry_n: 'geometry {i}/{n}',
            fbx_morph_targets: 'morph targets',
            fbx_skins: 'skins',
            fbx_animation: 'animation',
            fbx_animation_n: 'animation {i}/{n}',
            fbx_compressing: 'compressing',
            fbx_writing_file: 'writing file',
            fbx_done: 'done',
            set_language: 'Language:',
            set_language_tip: 'Language of this panel. Auto: the language of your browser.',
            opt_auto: 'Auto',
            set_max_seconds: 'Max seconds:',
            set_max_seconds_tip: 'Stops a manual recording after this time. RECORD SINGLE CLIP and RECORD ALL CLIPS stop by themselves at the end of each clip.',
            set_fps: 'Record FPS:',
            set_fps_tip: 'Frames per second in the recording. Max records every frame the viewer draws. Lower values make smaller files.',
            opt_fps_max: 'Max (every frame)',
            set_reload: 'Auto-reload:',
            set_reload_tip: 'On: reloads the page one time if the script cannot connect to the viewer. Off: no reload.',
            set_double: 'Double sided:',
            set_double_tip: 'On: materials show both sides, as in the viewer. Off: materials show the front side only.',
            set_single_auto: 'Auto single sided (viewer flag):',
            set_single_auto_tip: 'On: a material that the viewer shows single sided stays single sided. Off: the Double sided setting applies to all materials.',
            set_slivers: 'Drop strip slivers (stripes):',
            set_slivers_tip: 'On: removes long thin triangles that connect separate parts of a mesh. Off: keeps all triangles.',
            set_reduce: 'Reduce keyframes:',
            set_reduce_tip: 'On: leaves out animation keys that the keys before and after them already give. The file is about half as large. Off: keeps every recorded frame.',
            set_still: 'Keep still clips:',
            set_still_tip: 'On: a clip in which no joint moves (a pose clip) is exported as a pose of the skeleton. Off: such clips are left out of the file.',
            set_vcolor: 'Vertex color sRGB>linear:',
            set_vcolor_tip: 'On: converts vertex colors to linear color, as glTF requires. The colors then look as in the viewer. Off: writes the colors unchanged.',
            set_flat_mr: 'Flat metal/rough from viewer:',
            set_flat_mr_tip: 'On: materials without textures use the metalness and roughness of the viewer. Off: metalness 0, roughness 0.5.',
            set_scale: 'Export scale:',
            set_scale_tip: 'Multiplies the size of the whole model. Use 0.01 for a model in centimeters (comma or point).',
            set_mr_format: 'MR format:',
            set_mr_format_tip: 'File format of the merged metallic-roughness textures. JPEG: smaller files. PNG: no quality loss.',
            opt_jpeg: 'JPEG (small)',
            opt_png: 'PNG (lossless)',
            set_rest: 'Rest pose:',
            set_rest_tip: 'Sets the rest pose of the skeleton. Clip 1st frame: the first recorded frame. Static Pose: the Static Pose of the viewer.',
            opt_clip0: 'Clip 1st frame',
            opt_static: 'Static Pose',
        },
        pl: {
            settings: 'Ustawienia',
            sec_download: 'Pobierz',
            sec_animation: 'Animacja',
            btn_glb: 'GLB',
            btn_fbx: 'FBX',
            tip_glb: 'Pobierz plik ZIP z plikiem .glb i jego teksturami',
            tip_fbx: 'Pobierz plik ZIP z binarnym plikiem .fbx (FBX 7.4) i jego teksturami',
            btn_rec_single: 'NAGRAJ JEDEN KLIP',
            btn_rec_all: 'NAGRAJ WSZYSTKIE KLIPY',
            btn_stop: 'ZATRZYMAJ',
            btn_cancel: 'ANULUJ',
            btn_cancelling: 'ANULOWANIE...',
            tip_no_clips: 'Nie znaleziono klipów animacji w tym modelu',
            tip_one_clip: 'Tylko jeden klip: użyj NAGRAJ JEDEN KLIP (automatycznie nagrywa jedną pełną pętlę)',
            tip_busy: 'Trwa inne zadanie: poczekaj, aż się skończy',
            tip_busy_dl: 'Trwa nagrywanie lub eksport: poczekaj, aż się skończy',
            st_idle: 'gotowy',
            st_rec: '● NAGR.',
            st_clips: '● KLIPY {p}',
            st_line: '{state} · obiekty: {m} · klatki: {f} · klipy: {c}',
            st_rec_clips: ' (nagrano {n})',
            st_no_anchors: '⚠ brak połączenia z podglądem 3D — odśwież stronę',
            pr_recording: 'Nagrywanie: {name}',
            pr_recording_manual: 'Nagrywanie (naciśnij ZATRZYMAJ, aby zakończyć)',
            pr_seconds: '{t} / {d} s',
            pr_recorded_frames: { one: 'Nagrano {n} klatkę', few: 'Nagrano {n} klatki', many: 'Nagrano {n} klatek', other: 'Nagrano {n} klatki' },
            pr_recorded_clips: { one: 'Nagrano {n} klip', few: 'Nagrano {n} klipy', many: 'Nagrano {n} klipów', other: 'Nagrano {n} klipu' },
            pr_recording_failed: 'Nagrywanie nie powiodło się',
            pr_recording_cancelled: 'Nagrywanie anulowane',
            pr_done: 'Gotowe',
            pr_export_failed: 'Eksport nie powiódł się',
            pr_see_console: 'szczegóły znajdziesz w konsoli',
            stage_textures: 'Oczekiwanie na tekstury',
            stage_merge: 'Łączenie tekstur',
            stage_build: 'Budowanie sceny',
            stage_fbx: 'Zapisywanie pliku FBX',
            stage_split: 'Rozdzielanie map metaliczności/szorstkości',
            stage_zip: 'Pakowanie ZIP',
            pr_no_textures: 'brak tekstur',
            pr_all_captured: 'przechwycono wszystkie {n}',
            pr_captured_wait: 'przechwycono {got}/{total}, oczekiwanie do {s} s',
            pr_mr: 'metaliczność/szorstkość {d}/{n}',
            pr_no_mr: 'brak map metaliczności/szorstkości',
            pr_op: 'przezroczystość {d}/{n}',
            pr_no_op: 'brak map przezroczystości',
            pr_building: 'budowanie obiektów 3D, materiałów i klipów',
            fbx_nodes: 'węzły',
            fbx_materials: 'materiały',
            fbx_geometry: 'geometria',
            fbx_geometry_n: 'geometria {i}/{n}',
            fbx_morph_targets: 'klucze kształtu',
            fbx_skins: 'wagi kości',
            fbx_animation: 'animacja',
            fbx_animation_n: 'animacja {i}/{n}',
            fbx_compressing: 'kompresowanie',
            fbx_writing_file: 'zapisywanie pliku',
            fbx_done: 'gotowe',
            set_language: 'Język:',
            set_language_tip: 'Język tego panelu. Auto: język Twojej przeglądarki.',
            opt_auto: 'Auto',
            set_max_seconds: 'Maks. sekund:',
            set_max_seconds_tip: 'Zatrzymuje ręczne nagrywanie po tym czasie. NAGRAJ JEDEN KLIP i NAGRAJ WSZYSTKIE KLIPY kończą same na końcu każdego klipu.',
            set_fps: 'FPS nagrywania:',
            set_fps_tip: 'Klatki na sekundę w nagraniu. Maks. nagrywa każdą klatkę, którą rysuje podgląd 3D. Niższe wartości dają mniejsze pliki.',
            opt_fps_max: 'Maks. (każda klatka)',
            set_reload: 'Automatyczne odświeżanie:',
            set_reload_tip: 'Włączone: odświeża stronę jeden raz, jeśli skrypt nie może połączyć się z podglądem 3D. Wyłączone: bez odświeżania.',
            set_double: 'Dwustronne:',
            set_double_tip: 'Włączone: materiały pokazują obie strony, tak jak w podglądzie 3D. Wyłączone: materiały pokazują tylko przednią stronę.',
            set_single_auto: 'Jednostronne wg podglądu 3D:',
            set_single_auto_tip: 'Włączone: materiał, który podgląd 3D pokazuje jako jednostronny, zostaje jednostronny. Wyłączone: ustawienie Dwustronne dotyczy wszystkich materiałów.',
            set_slivers: 'Usuń cienkie trójkąty (paski):',
            set_slivers_tip: 'Włączone: usuwa długie, cienkie trójkąty, które łączą oddzielne części obiektu i są widoczne jako paski. Wyłączone: zostawia wszystkie trójkąty.',
            set_reduce: 'Redukuj klatki kluczowe:',
            set_reduce_tip: 'Włączone: pomija klucze animacji, które już wynikają z kluczy przed nimi i po nich. Plik jest mniej więcej o połowę mniejszy. Wyłączone: zostawia każdą nagraną klatkę.',
            set_still: 'Zachowaj nieruchome klipy:',
            set_still_tip: 'Włączone: klip, w którym żadna kość się nie porusza (klip pozy), jest eksportowany jako poza szkieletu. Wyłączone: takie klipy są pomijane.',
            set_vcolor: 'Kolory wierzchołków sRGB>liniowe:',
            set_vcolor_tip: 'Włączone: zamienia kolory wierzchołków na liniowe, jak wymaga glTF. Kolory wyglądają wtedy tak jak w podglądzie 3D. Wyłączone: zapisuje kolory bez zmian.',
            set_flat_mr: 'Metaliczność/szorstkość z podglądu:',
            set_flat_mr_tip: 'Włączone: materiały bez tekstur dostają metaliczność i szorstkość z podglądu 3D. Wyłączone: metaliczność 0, szorstkość 0,5.',
            set_scale: 'Skala eksportu:',
            set_scale_tip: 'Mnoży rozmiar całego modelu. Użyj 0,01 dla modelu w centymetrach (przecinek lub kropka).',
            set_mr_format: 'Format MR:',
            set_mr_format_tip: 'Format pliku połączonych tekstur metaliczności i szorstkości. JPEG: mniejsze pliki. PNG: bez utraty jakości.',
            opt_jpeg: 'JPEG (mały)',
            opt_png: 'PNG (bezstratny)',
            set_rest: 'Poza spoczynkowa:',
            set_rest_tip: 'Ustawia pozę spoczynkową szkieletu. Pierwsza klatka klipu: pierwsza nagrana klatka. Poza statyczna: element „Static Pose” w podglądzie 3D.',
            opt_clip0: 'Pierwsza klatka klipu',
            opt_static: 'Poza statyczna',
        },
        ru: {
            settings: 'Настройки',
            sec_download: 'Скачать',
            sec_animation: 'Анимация',
            btn_glb: 'GLB',
            btn_fbx: 'FBX',
            tip_glb: 'Скачать ZIP с файлом .glb и его текстурами',
            tip_fbx: 'Скачать ZIP с двоичным файлом .fbx (FBX 7.4) и его текстурами',
            btn_rec_single: 'ЗАПИСАТЬ ОДИН КЛИП',
            btn_rec_all: 'ЗАПИСАТЬ ВСЕ КЛИПЫ',
            btn_stop: 'СТОП',
            btn_cancel: 'ОТМЕНА',
            btn_cancelling: 'ОТМЕНА...',
            tip_no_clips: 'У этой модели не найдено клипов анимации',
            tip_one_clip: 'Только один клип: используйте ЗАПИСАТЬ ОДИН КЛИП (автоматически записывает один полный цикл)',
            tip_busy: 'Идёт другая задача: дождитесь её окончания',
            tip_busy_dl: 'Идёт запись или экспорт: дождитесь окончания',
            st_idle: 'готов',
            st_rec: '● ЗАП',
            st_clips: '● КЛИПЫ {p}',
            st_line: '{state} · объекты: {m} · кадры: {f} · клипы: {c}',
            st_rec_clips: ' (записано {n})',
            st_no_anchors: '⚠ нет связи с 3D-просмотром — перезагрузите страницу',
            pr_recording: 'Запись: {name}',
            pr_recording_manual: 'Запись (нажмите СТОП, чтобы закончить)',
            pr_seconds: '{t} / {d} с',
            pr_recorded_frames: { one: 'Записан {n} кадр', few: 'Записано {n} кадра', many: 'Записано {n} кадров', other: 'Записано {n} кадра' },
            pr_recorded_clips: { one: 'Записан {n} клип', few: 'Записано {n} клипа', many: 'Записано {n} клипов', other: 'Записано {n} клипа' },
            pr_recording_failed: 'Запись не удалась',
            pr_recording_cancelled: 'Запись отменена',
            pr_done: 'Готово',
            pr_export_failed: 'Экспорт не удался',
            pr_see_console: 'подробности в консоли',
            stage_textures: 'Ожидание текстур',
            stage_merge: 'Объединение текстур',
            stage_build: 'Сборка сцены',
            stage_fbx: 'Запись файла FBX',
            stage_split: 'Разделение карт металличности/шероховатости',
            stage_zip: 'Упаковка ZIP',
            pr_no_textures: 'нет текстур',
            pr_all_captured: 'получены все {n}',
            pr_captured_wait: 'получено {got}/{total}, ожидание до {s} с',
            pr_mr: 'металличность/шероховатость {d}/{n}',
            pr_no_mr: 'нет карт металличности/шероховатости',
            pr_op: 'прозрачность {d}/{n}',
            pr_no_op: 'нет карт прозрачности',
            pr_building: 'сборка 3D-объектов, материалов и клипов',
            fbx_nodes: 'узлы',
            fbx_materials: 'материалы',
            fbx_geometry: 'геометрия',
            fbx_geometry_n: 'геометрия {i}/{n}',
            fbx_morph_targets: 'ключи формы',
            fbx_skins: 'веса костей',
            fbx_animation: 'анимация',
            fbx_animation_n: 'анимация {i}/{n}',
            fbx_compressing: 'сжатие',
            fbx_writing_file: 'запись файла',
            fbx_done: 'готово',
            set_language: 'Язык:',
            set_language_tip: 'Язык этой панели. Авто: язык вашего браузера.',
            opt_auto: 'Авто',
            set_max_seconds: 'Макс. секунд:',
            set_max_seconds_tip: 'Останавливает ручную запись через это время. ЗАПИСАТЬ ОДИН КЛИП и ЗАПИСАТЬ ВСЕ КЛИПЫ останавливаются сами в конце каждого клипа.',
            set_fps: 'FPS записи:',
            set_fps_tip: 'Кадров в секунду в записи. Макс. записывает каждый кадр, который рисует 3D-просмотр. Меньшие значения дают файлы меньше.',
            opt_fps_max: 'Макс. (каждый кадр)',
            set_reload: 'Автоперезагрузка:',
            set_reload_tip: 'Вкл.: перезагружает страницу один раз, если скрипт не может подключиться к 3D-просмотру. Выкл.: без перезагрузки.',
            set_double: 'Двусторонние:',
            set_double_tip: 'Вкл.: материалы видны с обеих сторон, как в 3D-просмотре. Выкл.: материалы видны только с лицевой стороны.',
            set_single_auto: 'Односторонние по 3D-просмотру:',
            set_single_auto_tip: 'Вкл.: материал, который 3D-просмотр показывает односторонним, остаётся односторонним. Выкл.: настройка «Двусторонние» действует для всех материалов.',
            set_slivers: 'Убрать тонкие треугольники (полосы):',
            set_slivers_tip: 'Вкл.: убирает длинные тонкие треугольники, которые соединяют отдельные части объекта и видны как полосы. Выкл.: оставляет все треугольники.',
            set_reduce: 'Сократить ключевые кадры:',
            set_reduce_tip: 'Вкл.: пропускает ключи анимации, которые уже следуют из ключей до и после них. Файл примерно вдвое меньше. Выкл.: оставляет каждый записанный кадр.',
            set_still: 'Оставлять неподвижные клипы:',
            set_still_tip: 'Вкл.: клип, в котором ни одна кость не движется (клип позы), экспортируется как поза скелета. Выкл.: такие клипы не попадают в файл.',
            set_vcolor: 'Цвета вершин sRGB>линейные:',
            set_vcolor_tip: 'Вкл.: переводит цвета вершин в линейные, как требует glTF. Тогда цвета выглядят как в 3D-просмотре. Выкл.: записывает цвета без изменений.',
            set_flat_mr: 'Металличность/шероховатость из 3D-просмотра:',
            set_flat_mr_tip: 'Вкл.: материалы без текстур получают металличность и шероховатость из 3D-просмотра. Выкл.: металличность 0, шероховатость 0,5.',
            set_scale: 'Масштаб экспорта:',
            set_scale_tip: 'Умножает размер всей модели. Для модели в сантиметрах введите 0,01 (запятая или точка).',
            set_mr_format: 'Формат MR:',
            set_mr_format_tip: 'Формат файлов объединённых текстур металличности и шероховатости. JPEG: файлы меньше. PNG: без потери качества.',
            opt_jpeg: 'JPEG (меньше)',
            opt_png: 'PNG (без потерь)',
            set_rest: 'Поза покоя:',
            set_rest_tip: 'Задаёт позу покоя скелета. Первый кадр клипа: первый записанный кадр. Статичная поза: пункт «Static Pose» в 3D-просмотре.',
            opt_clip0: 'Первый кадр клипа',
            opt_static: 'Статичная поза',
        },
        ja: {
            settings: '設定',
            sec_download: 'ダウンロード',
            sec_animation: 'アニメーション',
            btn_glb: 'GLB',
            btn_fbx: 'FBX',
            tip_glb: '.glb ファイルとテクスチャを ZIP でダウンロード',
            tip_fbx: 'バイナリ .fbx ファイル (FBX 7.4) とテクスチャを ZIP でダウンロード',
            btn_rec_single: '1クリップを録画',
            btn_rec_all: '全クリップを録画',
            btn_stop: '停止',
            btn_cancel: 'キャンセル',
            btn_cancelling: 'キャンセル中...',
            tip_no_clips: 'このモデルにアニメーションクリップがありません',
            tip_one_clip: 'クリップは1つだけです: 「1クリップを録画」を使ってください (1ループを自動で録画します)',
            tip_busy: '処理中です: 現在の処理が終わるまでお待ちください',
            tip_busy_dl: '録画またはエクスポート中です: 終わるまでお待ちください',
            st_idle: '待機中',
            st_rec: '● 録画',
            st_clips: '● クリップ {p}',
            st_line: '{state} · オブジェクト: {m} · フレーム: {f} · クリップ: {c}',
            st_rec_clips: ' (録画済み {n})',
            st_no_anchors: '⚠ 3Dビューアーに接続できません — ページを再読み込みしてください',
            pr_recording: '録画中: {name}',
            pr_recording_manual: '録画中 (停止を押すと終了)',
            pr_seconds: '{t} / {d} 秒',
            pr_recorded_frames: { other: '{n} フレームを録画しました' },
            pr_recorded_clips: { other: '{n} クリップを録画しました' },
            pr_recording_failed: '録画に失敗しました',
            pr_recording_cancelled: '録画をキャンセルしました',
            pr_done: '完了',
            pr_export_failed: 'エクスポートに失敗しました',
            pr_see_console: '詳細はコンソールを参照',
            stage_textures: 'テクスチャを待機中',
            stage_merge: 'テクスチャを結合中',
            stage_build: 'シーンを構築中',
            stage_fbx: 'FBX ファイルを書き出し中',
            stage_split: 'メタリック/ラフネスマップを分割中',
            stage_zip: 'ZIP を作成中',
            pr_no_textures: 'テクスチャなし',
            pr_all_captured: '{n} 個すべて取得済み',
            pr_captured_wait: '{got}/{total} 取得済み、最大 {s} 秒待機',
            pr_mr: 'メタリック/ラフネス {d}/{n}',
            pr_no_mr: 'メタリック/ラフネスマップなし',
            pr_op: '不透明度 {d}/{n}',
            pr_no_op: '不透明度マップなし',
            pr_building: '3Dオブジェクト、マテリアル、クリップを構築中',
            fbx_nodes: 'ノード',
            fbx_materials: 'マテリアル',
            fbx_geometry: 'ジオメトリ',
            fbx_geometry_n: 'ジオメトリ {i}/{n}',
            fbx_morph_targets: 'シェイプキー',
            fbx_skins: 'ボーンウェイト',
            fbx_animation: 'アニメーション',
            fbx_animation_n: 'アニメーション {i}/{n}',
            fbx_compressing: '圧縮中',
            fbx_writing_file: 'ファイル書き出し中',
            fbx_done: '完了',
            set_language: '言語:',
            set_language_tip: 'このパネルの言語。自動: ブラウザの言語。',
            opt_auto: '自動',
            set_max_seconds: '最大秒数:',
            set_max_seconds_tip: '手動録画をこの時間で停止します。「1クリップを録画」と「全クリップを録画」は各クリップの終わりで自動的に停止します。',
            set_fps: '録画 FPS:',
            set_fps_tip: '録画の1秒あたりのフレーム数。最大: 3Dビューアーが描画するすべてのフレームを録画します。値を下げるとファイルが小さくなります。',
            opt_fps_max: '最大 (全フレーム)',
            set_reload: '自動再読み込み:',
            set_reload_tip: 'オン: スクリプトが3Dビューアーに接続できない場合、ページを1回だけ再読み込みします。オフ: 再読み込みしません。',
            set_double: '両面:',
            set_double_tip: 'オン: 3Dビューアーと同じく、マテリアルの両面を表示します。オフ: 表面だけを表示します。',
            set_single_auto: '3Dビューアーに合わせて片面:',
            set_single_auto_tip: 'オン: 3Dビューアーで片面表示のマテリアルは片面のままにします。オフ: 「両面」の設定をすべてのマテリアルに使います。',
            set_slivers: '細い三角形を削除 (縞模様):',
            set_slivers_tip: 'オン: オブジェクトの離れた部分をつなぐ、縞模様に見える細長い三角形を削除します。オフ: すべての三角形を残します。',
            set_reduce: 'キーフレームを削減:',
            set_reduce_tip: 'オン: 前後のキーから求められるアニメーションキーを省きます。ファイルは約半分になります。オフ: 録画したすべてのフレームを残します。',
            set_still: '静止クリップを残す:',
            set_still_tip: 'オン: どのボーンも動かないクリップ (ポーズクリップ) をスケルトンのポーズとしてエクスポートします。オフ: そのようなクリップはファイルに入れません。',
            set_vcolor: '頂点カラー sRGB>リニア:',
            set_vcolor_tip: 'オン: glTF の仕様どおり頂点カラーをリニアに変換します。色が3Dビューアーと同じに見えます。オフ: 色をそのまま書き出します。',
            set_flat_mr: '3Dビューアーのメタリック/ラフネス:',
            set_flat_mr_tip: 'オン: テクスチャのないマテリアルに3Dビューアーのメタリックとラフネスを使います。オフ: メタリック 0、ラフネス 0.5。',
            set_scale: 'エクスポートの倍率:',
            set_scale_tip: 'モデル全体のサイズを掛け算します。センチメートル単位のモデルには 0.01 を入力します (カンマでもピリオドでも可)。',
            set_mr_format: 'MR 形式:',
            set_mr_format_tip: '結合したメタリック/ラフネステクスチャのファイル形式。JPEG: ファイルが小さい。PNG: 画質の劣化なし。',
            opt_jpeg: 'JPEG (小さい)',
            opt_png: 'PNG (劣化なし)',
            set_rest: 'レストポーズ:',
            set_rest_tip: 'スケルトンのレストポーズを設定します。クリップの最初のフレーム: 最初に録画したフレーム。スタティックポーズ: 3Dビューアーの「Static Pose」。',
            opt_clip0: 'クリップの最初のフレーム',
            opt_static: 'スタティックポーズ',
        },
        ko: {
            settings: '설정',
            sec_download: '다운로드',
            sec_animation: '애니메이션',
            btn_glb: 'GLB',
            btn_fbx: 'FBX',
            tip_glb: '.glb 파일과 텍스처가 든 ZIP 다운로드',
            tip_fbx: '바이너리 .fbx 파일(FBX 7.4)과 텍스처가 든 ZIP 다운로드',
            btn_rec_single: '클립 하나 녹화',
            btn_rec_all: '모든 클립 녹화',
            btn_stop: '정지',
            btn_cancel: '취소',
            btn_cancelling: '취소하는 중...',
            tip_no_clips: '이 모델에서 애니메이션 클립을 찾지 못했습니다',
            tip_one_clip: '클립이 하나뿐입니다: 클립 하나 녹화를 사용하세요 (한 바퀴 전체를 자동으로 녹화합니다)',
            tip_busy: '다른 작업 중입니다: 끝날 때까지 기다리세요',
            tip_busy_dl: '녹화 또는 내보내기 중입니다: 끝날 때까지 기다리세요',
            st_idle: '대기',
            st_rec: '● 녹화',
            st_clips: '● 클립 {p}',
            st_line: '{state} · 오브젝트: {m} · 프레임: {f} · 클립: {c}',
            st_rec_clips: ' (녹화됨 {n})',
            st_no_anchors: '⚠ 3D 뷰어에 연결되지 않았습니다 — 페이지를 새로고침하세요',
            pr_recording: '녹화 중: {name}',
            pr_recording_manual: '녹화 중 (끝내려면 정지를 누르세요)',
            pr_seconds: '{t} / {d}초',
            pr_recorded_frames: { other: '프레임 {n}개를 녹화했습니다' },
            pr_recorded_clips: { other: '클립 {n}개를 녹화했습니다' },
            pr_recording_failed: '녹화에 실패했습니다',
            pr_recording_cancelled: '녹화를 취소했습니다',
            pr_done: '완료',
            pr_export_failed: '내보내기에 실패했습니다',
            pr_see_console: '자세한 내용은 콘솔을 보세요',
            stage_textures: '텍스처를 기다리는 중',
            stage_merge: '텍스처 합치는 중',
            stage_build: '장면 만드는 중',
            stage_fbx: 'FBX 파일 쓰는 중',
            stage_split: '메탈릭/러프니스 맵 나누는 중',
            stage_zip: 'ZIP 만드는 중',
            pr_no_textures: '텍스처 없음',
            pr_all_captured: '{n}개 모두 받음',
            pr_captured_wait: '{got}/{total}개 받음, 최대 {s}초 기다림',
            pr_mr: '메탈릭/러프니스 {d}/{n}',
            pr_no_mr: '메탈릭/러프니스 맵 없음',
            pr_op: '불투명도 {d}/{n}',
            pr_no_op: '불투명도 맵 없음',
            pr_building: '3D 오브젝트, 머티리얼, 클립 만드는 중',
            fbx_nodes: '노드',
            fbx_materials: '머티리얼',
            fbx_geometry: '지오메트리',
            fbx_geometry_n: '지오메트리 {i}/{n}',
            fbx_morph_targets: '셰이프 키',
            fbx_skins: '본 웨이트',
            fbx_animation: '애니메이션',
            fbx_animation_n: '애니메이션 {i}/{n}',
            fbx_compressing: '압축 중',
            fbx_writing_file: '파일 쓰는 중',
            fbx_done: '완료',
            set_language: '언어:',
            set_language_tip: '이 패널의 언어. 자동: 브라우저 언어.',
            opt_auto: '자동',
            set_max_seconds: '최대 초:',
            set_max_seconds_tip: '수동 녹화를 이 시간 뒤에 멈춥니다. 클립 하나 녹화와 모든 클립 녹화는 각 클립이 끝나면 스스로 멈춥니다.',
            set_fps: '녹화 FPS:',
            set_fps_tip: '녹화의 초당 프레임 수. 최대: 3D 뷰어가 그리는 모든 프레임을 녹화합니다. 값이 낮을수록 파일이 작아집니다.',
            opt_fps_max: '최대 (모든 프레임)',
            set_reload: '자동 새로고침:',
            set_reload_tip: '켜짐: 스크립트가 3D 뷰어에 연결하지 못하면 페이지를 한 번 새로고침합니다. 꺼짐: 새로고침하지 않습니다.',
            set_double: '양면:',
            set_double_tip: '켜짐: 3D 뷰어처럼 머티리얼의 양면을 보여 줍니다. 꺼짐: 앞면만 보여 줍니다.',
            set_single_auto: '3D 뷰어에 맞춰 단면:',
            set_single_auto_tip: '켜짐: 3D 뷰어가 단면으로 보여 주는 머티리얼은 단면으로 둡니다. 꺼짐: 양면 설정을 모든 머티리얼에 적용합니다.',
            set_slivers: '가는 삼각형 제거 (줄무늬):',
            set_slivers_tip: '켜짐: 오브젝트의 떨어진 부분을 잇고 줄무늬로 보이는 길고 가는 삼각형을 없앱니다. 꺼짐: 모든 삼각형을 남깁니다.',
            set_reduce: '키프레임 줄이기:',
            set_reduce_tip: '켜짐: 앞뒤 키로 이미 알 수 있는 애니메이션 키를 뺍니다. 파일이 절반쯤 작아집니다. 꺼짐: 녹화한 모든 프레임을 남깁니다.',
            set_still: '정지 클립 유지:',
            set_still_tip: '켜짐: 움직이는 본이 없는 클립(포즈 클립)을 스켈레톤 포즈로 내보냅니다. 꺼짐: 그런 클립은 파일에 넣지 않습니다.',
            set_vcolor: '버텍스 컬러 sRGB>선형:',
            set_vcolor_tip: '켜짐: glTF 규칙대로 버텍스 컬러를 선형으로 바꿉니다. 그러면 색이 3D 뷰어와 같아 보입니다. 꺼짐: 색을 그대로 씁니다.',
            set_flat_mr: '3D 뷰어의 메탈릭/러프니스:',
            set_flat_mr_tip: '켜짐: 텍스처가 없는 머티리얼은 3D 뷰어의 메탈릭과 러프니스를 씁니다. 꺼짐: 메탈릭 0, 러프니스 0.5.',
            set_scale: '내보내기 배율:',
            set_scale_tip: '모델 전체 크기에 곱합니다. 센티미터 단위 모델은 0.01을 쓰세요 (쉼표나 마침표).',
            set_mr_format: 'MR 형식:',
            set_mr_format_tip: '합친 메탈릭-러프니스 텍스처의 파일 형식. JPEG: 파일이 작음. PNG: 화질 손실 없음.',
            opt_jpeg: 'JPEG (작음)',
            opt_png: 'PNG (무손실)',
            set_rest: '레스트 포즈:',
            set_rest_tip: '스켈레톤의 레스트 포즈를 정합니다. 클립 첫 프레임: 처음 녹화한 프레임. 스태틱 포즈: 3D 뷰어의 "Static Pose".',
            opt_clip0: '클립 첫 프레임',
            opt_static: '스태틱 포즈',
        },
        es: {
            settings: 'Ajustes',
            sec_download: 'Descargar',
            sec_animation: 'Animación',
            btn_glb: 'GLB',
            btn_fbx: 'FBX',
            tip_glb: 'Descarga un ZIP con un archivo .glb y sus texturas',
            tip_fbx: 'Descarga un ZIP con un archivo .fbx binario (FBX 7.4) y sus texturas',
            btn_rec_single: 'GRABAR UN CLIP',
            btn_rec_all: 'GRABAR TODOS LOS CLIPS',
            btn_stop: 'DETENER',
            btn_cancel: 'CANCELAR',
            btn_cancelling: 'CANCELANDO...',
            tip_no_clips: 'Este modelo no tiene clips de animación',
            tip_one_clip: 'Solo hay un clip: usa GRABAR UN CLIP (graba un ciclo completo automáticamente)',
            tip_busy: 'Hay otra tarea en curso: espera a que termine',
            tip_busy_dl: 'Hay una grabación o exportación en curso: espera a que termine',
            st_idle: 'listo',
            st_rec: '● GRAB',
            st_clips: '● CLIPS {p}',
            st_line: '{state} · objetos: {m} · fotogramas: {f} · clips: {c}',
            st_rec_clips: ' (grabados {n})',
            st_no_anchors: '⚠ sin conexión con el visor 3D — recarga la página',
            pr_recording: 'Grabando {name}',
            pr_recording_manual: 'Grabando (pulsa DETENER para terminar)',
            pr_seconds: '{t} / {d} s',
            pr_recorded_frames: { one: '{n} fotograma grabado', many: '{n} fotogramas grabados', other: '{n} fotogramas grabados' },
            pr_recorded_clips: { one: '{n} clip grabado', many: '{n} clips grabados', other: '{n} clips grabados' },
            pr_recording_failed: 'La grabación falló',
            pr_recording_cancelled: 'Grabación cancelada',
            pr_done: 'Listo',
            pr_export_failed: 'La exportación falló',
            pr_see_console: 'consulta la consola para ver los detalles',
            stage_textures: 'Esperando texturas',
            stage_merge: 'Combinando texturas',
            stage_build: 'Construyendo la escena',
            stage_fbx: 'Escribiendo el archivo FBX',
            stage_split: 'Separando mapas de metálico/rugosidad',
            stage_zip: 'Empaquetando ZIP',
            pr_no_textures: 'sin texturas',
            pr_all_captured: 'capturadas las {n}',
            pr_captured_wait: '{got}/{total} capturadas, esperando hasta {s} s',
            pr_mr: 'metálico/rugosidad {d}/{n}',
            pr_no_mr: 'sin mapas de metálico/rugosidad',
            pr_op: 'opacidad {d}/{n}',
            pr_no_op: 'sin mapas de opacidad',
            pr_building: 'construyendo objetos 3D, materiales y clips',
            fbx_nodes: 'nodos',
            fbx_materials: 'materiales',
            fbx_geometry: 'geometría',
            fbx_geometry_n: 'geometría {i}/{n}',
            fbx_morph_targets: 'claves de forma',
            fbx_skins: 'pesos de huesos',
            fbx_animation: 'animación',
            fbx_animation_n: 'animación {i}/{n}',
            fbx_compressing: 'comprimiendo',
            fbx_writing_file: 'escribiendo el archivo',
            fbx_done: 'listo',
            set_language: 'Idioma:',
            set_language_tip: 'Idioma de este panel. Auto: el idioma de tu navegador.',
            opt_auto: 'Auto',
            set_max_seconds: 'Segundos máx.:',
            set_max_seconds_tip: 'Detiene una grabación manual tras este tiempo. GRABAR UN CLIP y GRABAR TODOS LOS CLIPS se detienen solos al final de cada clip.',
            set_fps: 'FPS de grabación:',
            set_fps_tip: 'Fotogramas por segundo en la grabación. Máx. graba cada fotograma que dibuja el visor 3D. Los valores bajos dan archivos más pequeños.',
            opt_fps_max: 'Máx. (cada fotograma)',
            set_reload: 'Recarga automática:',
            set_reload_tip: 'Activado: recarga la página una vez si el script no puede conectar con el visor 3D. Desactivado: no recarga.',
            set_double: 'Doble cara:',
            set_double_tip: 'Activado: los materiales muestran ambas caras, como en el visor 3D. Desactivado: solo muestran la cara frontal.',
            set_single_auto: 'Una cara según el visor 3D:',
            set_single_auto_tip: 'Activado: un material que el visor 3D muestra a una cara sigue siendo de una cara. Desactivado: el ajuste Doble cara se aplica a todos los materiales.',
            set_slivers: 'Quitar triángulos finos (rayas):',
            set_slivers_tip: 'Activado: quita los triángulos largos y finos que unen partes separadas de un objeto y se ven como rayas. Desactivado: conserva todos los triángulos.',
            set_reduce: 'Reducir fotogramas clave:',
            set_reduce_tip: 'Activado: omite las claves de animación que ya se deducen de las claves anteriores y posteriores. El archivo ocupa más o menos la mitad. Desactivado: conserva cada fotograma grabado.',
            set_still: 'Conservar clips quietos:',
            set_still_tip: 'Activado: un clip en el que ningún hueso se mueve (un clip de pose) se exporta como una pose del esqueleto. Desactivado: esos clips no se incluyen en el archivo.',
            set_vcolor: 'Color de vértices sRGB>lineal:',
            set_vcolor_tip: 'Activado: convierte los colores de vértice a lineales, como exige glTF. Así los colores se ven como en el visor 3D. Desactivado: escribe los colores sin cambios.',
            set_flat_mr: 'Metálico/rugosidad del visor:',
            set_flat_mr_tip: 'Activado: los materiales sin texturas usan el metálico y la rugosidad del visor 3D. Desactivado: metálico 0, rugosidad 0,5.',
            set_scale: 'Escala de exportación:',
            set_scale_tip: 'Multiplica el tamaño de todo el modelo. Usa 0,01 para un modelo en centímetros (coma o punto).',
            set_mr_format: 'Formato MR:',
            set_mr_format_tip: 'Formato de archivo de las texturas combinadas de metálico y rugosidad. JPEG: archivos más pequeños. PNG: sin pérdida de calidad.',
            opt_jpeg: 'JPEG (pequeño)',
            opt_png: 'PNG (sin pérdida)',
            set_rest: 'Pose de reposo:',
            set_rest_tip: 'Define la pose de reposo del esqueleto. Primer fotograma del clip: el primer fotograma grabado. Pose estática: la opción «Static Pose» del visor 3D.',
            opt_clip0: 'Primer fotograma del clip',
            opt_static: 'Pose estática',
        },
        'pt-BR': {
            settings: 'Configurações',
            sec_download: 'Baixar',
            sec_animation: 'Animação',
            btn_glb: 'GLB',
            btn_fbx: 'FBX',
            tip_glb: 'Baixar um ZIP com um arquivo .glb e suas texturas',
            tip_fbx: 'Baixar um ZIP com um arquivo .fbx binário (FBX 7.4) e suas texturas',
            btn_rec_single: 'GRAVAR UM CLIPE',
            btn_rec_all: 'GRAVAR TODOS OS CLIPES',
            btn_stop: 'PARAR',
            btn_cancel: 'CANCELAR',
            btn_cancelling: 'CANCELANDO...',
            tip_no_clips: 'Este modelo não tem clipes de animação',
            tip_one_clip: 'Só há um clipe: use GRAVAR UM CLIPE (grava um ciclo completo automaticamente)',
            tip_busy: 'Outra tarefa em andamento: espere terminar',
            tip_busy_dl: 'Gravação ou exportação em andamento: espere terminar',
            st_idle: 'pronto',
            st_rec: '● GRAV',
            st_clips: '● CLIPES {p}',
            st_line: '{state} · objetos: {m} · quadros: {f} · clipes: {c}',
            st_rec_clips: ' (gravados {n})',
            st_no_anchors: '⚠ sem conexão com o visualizador 3D — recarregue a página',
            pr_recording: 'Gravando {name}',
            pr_recording_manual: 'Gravando (clique em PARAR para terminar)',
            pr_seconds: '{t} / {d} s',
            pr_recorded_frames: { one: '{n} quadro gravado', many: '{n} quadros gravados', other: '{n} quadros gravados' },
            pr_recorded_clips: { one: '{n} clipe gravado', many: '{n} clipes gravados', other: '{n} clipes gravados' },
            pr_recording_failed: 'A gravação falhou',
            pr_recording_cancelled: 'Gravação cancelada',
            pr_done: 'Pronto',
            pr_export_failed: 'A exportação falhou',
            pr_see_console: 'veja os detalhes no console',
            stage_textures: 'Aguardando texturas',
            stage_merge: 'Combinando texturas',
            stage_build: 'Montando a cena',
            stage_fbx: 'Gravando o arquivo FBX',
            stage_split: 'Separando mapas de metálico/rugosidade',
            stage_zip: 'Compactando ZIP',
            pr_no_textures: 'sem texturas',
            pr_all_captured: 'todas as {n} capturadas',
            pr_captured_wait: '{got}/{total} capturadas, aguardando até {s} s',
            pr_mr: 'metálico/rugosidade {d}/{n}',
            pr_no_mr: 'sem mapas de metálico/rugosidade',
            pr_op: 'opacidade {d}/{n}',
            pr_no_op: 'sem mapas de opacidade',
            pr_building: 'montando objetos 3D, materiais e clipes',
            fbx_nodes: 'nós',
            fbx_materials: 'materiais',
            fbx_geometry: 'geometria',
            fbx_geometry_n: 'geometria {i}/{n}',
            fbx_morph_targets: 'shape keys',
            fbx_skins: 'pesos dos ossos',
            fbx_animation: 'animação',
            fbx_animation_n: 'animação {i}/{n}',
            fbx_compressing: 'compactando',
            fbx_writing_file: 'gravando o arquivo',
            fbx_done: 'pronto',
            set_language: 'Idioma:',
            set_language_tip: 'Idioma deste painel. Auto: o idioma do seu navegador.',
            opt_auto: 'Auto',
            set_max_seconds: 'Segundos máx.:',
            set_max_seconds_tip: 'Para uma gravação manual depois deste tempo. GRAVAR UM CLIPE e GRAVAR TODOS OS CLIPES param sozinhos no fim de cada clipe.',
            set_fps: 'FPS da gravação:',
            set_fps_tip: 'Quadros por segundo na gravação. Máx. grava cada quadro que o visualizador 3D desenha. Valores menores geram arquivos menores.',
            opt_fps_max: 'Máx. (cada quadro)',
            set_reload: 'Recarregar sozinho:',
            set_reload_tip: 'Ligado: recarrega a página uma vez se o script não conseguir conectar ao visualizador 3D. Desligado: não recarrega.',
            set_double: 'Dupla face:',
            set_double_tip: 'Ligado: os materiais mostram os dois lados, como no visualizador 3D. Desligado: mostram só o lado da frente.',
            set_single_auto: 'Face única conforme o visualizador:',
            set_single_auto_tip: 'Ligado: um material que o visualizador 3D mostra com face única continua com face única. Desligado: a configuração Dupla face vale para todos os materiais.',
            set_slivers: 'Remover triângulos finos (listras):',
            set_slivers_tip: 'Ligado: remove triângulos longos e finos que ligam partes separadas de um objeto e aparecem como listras. Desligado: mantém todos os triângulos.',
            set_reduce: 'Reduzir quadros-chave:',
            set_reduce_tip: 'Ligado: deixa de fora as chaves de animação que já resultam das chaves antes e depois delas. O arquivo fica com cerca de metade do tamanho. Desligado: mantém cada quadro gravado.',
            set_still: 'Manter clipes parados:',
            set_still_tip: 'Ligado: um clipe em que nenhum osso se move (um clipe de pose) é exportado como uma pose do esqueleto. Desligado: esses clipes ficam fora do arquivo.',
            set_vcolor: 'Cor de vértice sRGB>linear:',
            set_vcolor_tip: 'Ligado: converte as cores de vértice para linear, como o glTF exige. As cores ficam como no visualizador 3D. Desligado: grava as cores sem mudança.',
            set_flat_mr: 'Metálico/rugosidade do visualizador:',
            set_flat_mr_tip: 'Ligado: materiais sem texturas usam o metálico e a rugosidade do visualizador 3D. Desligado: metálico 0, rugosidade 0,5.',
            set_scale: 'Escala de exportação:',
            set_scale_tip: 'Multiplica o tamanho do modelo inteiro. Use 0,01 para um modelo em centímetros (vírgula ou ponto).',
            set_mr_format: 'Formato MR:',
            set_mr_format_tip: 'Formato de arquivo das texturas combinadas de metálico e rugosidade. JPEG: arquivos menores. PNG: sem perda de qualidade.',
            opt_jpeg: 'JPEG (pequeno)',
            opt_png: 'PNG (sem perda)',
            set_rest: 'Pose de repouso:',
            set_rest_tip: 'Define a pose de repouso do esqueleto. Primeiro quadro do clipe: o primeiro quadro gravado. Pose estática: a opção "Static Pose" do visualizador 3D.',
            opt_clip0: 'Primeiro quadro do clipe',
            opt_static: 'Pose estática',
        },
        de: {
            settings: 'Einstellungen',
            sec_download: 'Herunterladen',
            sec_animation: 'Animation',
            btn_glb: 'GLB',
            btn_fbx: 'FBX',
            tip_glb: 'ZIP mit einer .glb-Datei und ihren Texturen herunterladen',
            tip_fbx: 'ZIP mit einer binären .fbx-Datei (FBX 7.4) und ihren Texturen herunterladen',
            btn_rec_single: 'EINEN CLIP AUFNEHMEN',
            btn_rec_all: 'ALLE CLIPS AUFNEHMEN',
            btn_stop: 'STOPP',
            btn_cancel: 'ABBRECHEN',
            btn_cancelling: 'WIRD ABGEBROCHEN...',
            tip_no_clips: 'Dieses Modell hat keine Animationsclips',
            tip_one_clip: 'Nur ein Clip: EINEN CLIP AUFNEHMEN verwenden (nimmt automatisch eine volle Schleife auf)',
            tip_busy: 'Eine andere Aufgabe läuft: warten, bis sie fertig ist',
            tip_busy_dl: 'Aufnahme oder Export läuft: warten, bis sie fertig sind',
            st_idle: 'bereit',
            st_rec: '● AUFN',
            st_clips: '● CLIPS {p}',
            st_line: '{state} · Objekte: {m} · Frames: {f} · Clips: {c}',
            st_rec_clips: ' ({n} aufgenommen)',
            st_no_anchors: '⚠ keine Verbindung zur 3D-Ansicht — Seite neu laden',
            pr_recording: 'Aufnahme: {name}',
            pr_recording_manual: 'Aufnahme (STOPP drücken zum Beenden)',
            pr_seconds: '{t} / {d} s',
            pr_recorded_frames: { one: '{n} Frame aufgenommen', other: '{n} Frames aufgenommen' },
            pr_recorded_clips: { one: '{n} Clip aufgenommen', other: '{n} Clips aufgenommen' },
            pr_recording_failed: 'Aufnahme fehlgeschlagen',
            pr_recording_cancelled: 'Aufnahme abgebrochen',
            pr_done: 'Fertig',
            pr_export_failed: 'Export fehlgeschlagen',
            pr_see_console: 'Details in der Konsole',
            stage_textures: 'Warten auf Texturen',
            stage_merge: 'Texturen zusammenführen',
            stage_build: 'Szene aufbauen',
            stage_fbx: 'FBX-Datei schreiben',
            stage_split: 'Metallic/Roughness-Maps trennen',
            stage_zip: 'ZIP packen',
            pr_no_textures: 'keine Texturen',
            pr_all_captured: 'alle {n} erfasst',
            pr_captured_wait: '{got}/{total} erfasst, warte bis zu {s} s',
            pr_mr: 'Metallic/Roughness {d}/{n}',
            pr_no_mr: 'keine Metallic/Roughness-Maps',
            pr_op: 'Deckkraft {d}/{n}',
            pr_no_op: 'keine Deckkraft-Maps',
            pr_building: '3D-Objekte, Materialien und Clips aufbauen',
            fbx_nodes: 'Knoten',
            fbx_materials: 'Materialien',
            fbx_geometry: 'Geometrie',
            fbx_geometry_n: 'Geometrie {i}/{n}',
            fbx_morph_targets: 'Shape Keys',
            fbx_skins: 'Knochengewichte',
            fbx_animation: 'Animation',
            fbx_animation_n: 'Animation {i}/{n}',
            fbx_compressing: 'Komprimieren',
            fbx_writing_file: 'Datei schreiben',
            fbx_done: 'fertig',
            set_language: 'Sprache:',
            set_language_tip: 'Sprache dieses Panels. Auto: die Sprache deines Browsers.',
            opt_auto: 'Auto',
            set_max_seconds: 'Max. Sekunden:',
            set_max_seconds_tip: 'Beendet eine manuelle Aufnahme nach dieser Zeit. EINEN CLIP AUFNEHMEN und ALLE CLIPS AUFNEHMEN stoppen am Ende jedes Clips von selbst.',
            set_fps: 'Aufnahme-FPS:',
            set_fps_tip: 'Frames pro Sekunde in der Aufnahme. Max. nimmt jeden Frame auf, den die 3D-Ansicht zeichnet. Kleinere Werte ergeben kleinere Dateien.',
            opt_fps_max: 'Max. (jeder Frame)',
            set_reload: 'Automatisch neu laden:',
            set_reload_tip: 'An: lädt die Seite einmal neu, wenn das Skript keine Verbindung zur 3D-Ansicht bekommt. Aus: kein Neuladen.',
            set_double: 'Doppelseitig:',
            set_double_tip: 'An: Materialien zeigen beide Seiten, wie in der 3D-Ansicht. Aus: Materialien zeigen nur die Vorderseite.',
            set_single_auto: 'Einseitig wie in der 3D-Ansicht:',
            set_single_auto_tip: 'An: ein Material, das die 3D-Ansicht einseitig zeigt, bleibt einseitig. Aus: die Einstellung Doppelseitig gilt für alle Materialien.',
            set_slivers: 'Dünne Dreiecke entfernen (Streifen):',
            set_slivers_tip: 'An: entfernt lange, dünne Dreiecke, die getrennte Teile eines Objekts verbinden und als Streifen sichtbar sind. Aus: behält alle Dreiecke.',
            set_reduce: 'Keyframes reduzieren:',
            set_reduce_tip: 'An: lässt Animationskeys weg, die sich schon aus den Keys davor und danach ergeben. Die Datei ist etwa halb so groß. Aus: behält jeden aufgenommenen Frame.',
            set_still: 'Unbewegte Clips behalten:',
            set_still_tip: 'An: ein Clip, in dem sich kein Knochen bewegt (ein Posen-Clip), wird als Pose des Skeletts exportiert. Aus: solche Clips kommen nicht in die Datei.',
            set_vcolor: 'Vertexfarben sRGB>linear:',
            set_vcolor_tip: 'An: wandelt Vertexfarben in lineare Farben um, wie glTF es verlangt. Die Farben sehen dann aus wie in der 3D-Ansicht. Aus: schreibt die Farben unverändert.',
            set_flat_mr: 'Metallic/Roughness aus der 3D-Ansicht:',
            set_flat_mr_tip: 'An: Materialien ohne Texturen bekommen Metallic und Roughness aus der 3D-Ansicht. Aus: Metallic 0, Roughness 0,5.',
            set_scale: 'Export-Skalierung:',
            set_scale_tip: 'Multipliziert die Größe des ganzen Modells. 0,01 für ein Modell in Zentimetern verwenden (Komma oder Punkt).',
            set_mr_format: 'MR-Format:',
            set_mr_format_tip: 'Dateiformat der zusammengeführten Metallic-Roughness-Texturen. JPEG: kleinere Dateien. PNG: kein Qualitätsverlust.',
            opt_jpeg: 'JPEG (klein)',
            opt_png: 'PNG (verlustfrei)',
            set_rest: 'Ruhepose:',
            set_rest_tip: 'Legt die Ruhepose des Skeletts fest. Erster Frame des Clips: der erste aufgenommene Frame. Statische Pose: der Eintrag „Static Pose“ der 3D-Ansicht.',
            opt_clip0: 'Erster Frame des Clips',
            opt_static: 'Statische Pose',
        },
        fr: {
            settings: 'Paramètres',
            sec_download: 'Télécharger',
            sec_animation: 'Animation',
            btn_glb: 'GLB',
            btn_fbx: 'FBX',
            tip_glb: 'Télécharger un ZIP avec un fichier .glb et ses textures',
            tip_fbx: 'Télécharger un ZIP avec un fichier .fbx binaire (FBX 7.4) et ses textures',
            btn_rec_single: 'ENREGISTRER UN CLIP',
            btn_rec_all: 'ENREGISTRER TOUS LES CLIPS',
            btn_stop: 'ARRÊTER',
            btn_cancel: 'ANNULER',
            btn_cancelling: 'ANNULATION...',
            tip_no_clips: 'Aucun clip d’animation trouvé sur ce modèle',
            tip_one_clip: 'Un seul clip : utilisez ENREGISTRER UN CLIP (enregistre automatiquement une boucle complète)',
            tip_busy: 'Une autre tâche est en cours : attendez qu’elle se termine',
            tip_busy_dl: 'Un enregistrement ou un export est en cours : attendez la fin',
            st_idle: 'prêt',
            st_rec: '● ENR',
            st_clips: '● CLIPS {p}',
            st_line: '{state} · objets : {m} · images : {f} · clips : {c}',
            st_rec_clips: ' ({n} enregistrés)',
            st_no_anchors: '⚠ pas de connexion à la visionneuse 3D — rechargez la page',
            pr_recording: 'Enregistrement : {name}',
            pr_recording_manual: 'Enregistrement (appuyez sur ARRÊTER pour finir)',
            pr_seconds: '{t} / {d} s',
            pr_recorded_frames: { one: '{n} image enregistrée', many: '{n} images enregistrées', other: '{n} images enregistrées' },
            pr_recorded_clips: { one: '{n} clip enregistré', many: '{n} clips enregistrés', other: '{n} clips enregistrés' },
            pr_recording_failed: 'L’enregistrement a échoué',
            pr_recording_cancelled: 'Enregistrement annulé',
            pr_done: 'Terminé',
            pr_export_failed: 'L’export a échoué',
            pr_see_console: 'détails dans la console',
            stage_textures: 'Attente des textures',
            stage_merge: 'Fusion des textures',
            stage_build: 'Construction de la scène',
            stage_fbx: 'Écriture du fichier FBX',
            stage_split: 'Séparation des cartes métal/rugosité',
            stage_zip: 'Création du ZIP',
            pr_no_textures: 'aucune texture',
            pr_all_captured: 'les {n} sont capturées',
            pr_captured_wait: '{got}/{total} capturées, attente jusqu’à {s} s',
            pr_mr: 'métal/rugosité {d}/{n}',
            pr_no_mr: 'aucune carte métal/rugosité',
            pr_op: 'opacité {d}/{n}',
            pr_no_op: 'aucune carte d’opacité',
            pr_building: 'construction des objets 3D, matériaux et clips',
            fbx_nodes: 'nœuds',
            fbx_materials: 'matériaux',
            fbx_geometry: 'géométrie',
            fbx_geometry_n: 'géométrie {i}/{n}',
            fbx_morph_targets: 'clés de forme',
            fbx_skins: 'poids des os',
            fbx_animation: 'animation',
            fbx_animation_n: 'animation {i}/{n}',
            fbx_compressing: 'compression',
            fbx_writing_file: 'écriture du fichier',
            fbx_done: 'terminé',
            set_language: 'Langue :',
            set_language_tip: 'Langue de ce panneau. Auto : la langue de votre navigateur.',
            opt_auto: 'Auto',
            set_max_seconds: 'Secondes max. :',
            set_max_seconds_tip: 'Arrête un enregistrement manuel après cette durée. ENREGISTRER UN CLIP et ENREGISTRER TOUS LES CLIPS s’arrêtent seuls à la fin de chaque clip.',
            set_fps: 'IPS d’enregistrement :',
            set_fps_tip: 'Images par seconde dans l’enregistrement. Max. enregistre chaque image dessinée par la visionneuse 3D. Des valeurs plus basses donnent des fichiers plus petits.',
            opt_fps_max: 'Max. (chaque image)',
            set_reload: 'Rechargement auto :',
            set_reload_tip: 'Activé : recharge la page une fois si le script ne peut pas se connecter à la visionneuse 3D. Désactivé : pas de rechargement.',
            set_double: 'Double face :',
            set_double_tip: 'Activé : les matériaux montrent les deux faces, comme dans la visionneuse 3D. Désactivé : ils ne montrent que la face avant.',
            set_single_auto: 'Simple face selon la visionneuse :',
            set_single_auto_tip: 'Activé : un matériau que la visionneuse 3D affiche en simple face reste en simple face. Désactivé : le réglage Double face s’applique à tous les matériaux.',
            set_slivers: 'Supprimer les triangles fins (rayures) :',
            set_slivers_tip: 'Activé : supprime les longs triangles fins qui relient des parties séparées d’un objet et apparaissent comme des rayures. Désactivé : garde tous les triangles.',
            set_reduce: 'Réduire les images clés :',
            set_reduce_tip: 'Activé : omet les clés d’animation que les clés avant et après donnent déjà. Le fichier est environ deux fois plus petit. Désactivé : garde chaque image enregistrée.',
            set_still: 'Garder les clips immobiles :',
            set_still_tip: 'Activé : un clip où aucun os ne bouge (un clip de pose) est exporté comme une pose du squelette. Désactivé : ces clips ne sont pas mis dans le fichier.',
            set_vcolor: 'Couleurs de sommets sRGB>linéaire :',
            set_vcolor_tip: 'Activé : convertit les couleurs de sommets en couleurs linéaires, comme glTF l’exige. Les couleurs ressemblent alors à celles de la visionneuse 3D. Désactivé : écrit les couleurs sans changement.',
            set_flat_mr: 'Métal/rugosité de la visionneuse :',
            set_flat_mr_tip: 'Activé : les matériaux sans texture reprennent le métal et la rugosité de la visionneuse 3D. Désactivé : métal 0, rugosité 0,5.',
            set_scale: 'Échelle d’export :',
            set_scale_tip: 'Multiplie la taille du modèle entier. Utilisez 0,01 pour un modèle en centimètres (virgule ou point).',
            set_mr_format: 'Format MR :',
            set_mr_format_tip: 'Format de fichier des textures métal-rugosité fusionnées. JPEG : fichiers plus petits. PNG : sans perte de qualité.',
            opt_jpeg: 'JPEG (petit)',
            opt_png: 'PNG (sans perte)',
            set_rest: 'Pose de repos :',
            set_rest_tip: 'Définit la pose de repos du squelette. Première image du clip : la première image enregistrée. Pose statique : l’entrée « Static Pose » de la visionneuse 3D.',
            opt_clip0: 'Première image du clip',
            opt_static: 'Pose statique',
        },
    };
    // @i18n-end
    // Names of the languages, each in its own language (not translated).
    const LANG_NAMES = { en: 'English', pl: 'Polski', ru: 'Русский', ja: '日本語', ko: '한국어', es: 'Español', 'pt-BR': 'Português (Brasil)', de: 'Deutsch', fr: 'Français', 'zh-CN': '简体中文' };

    function uiLang() {
        const c = CONFIG.LANGUAGE;
        if (c && c !== 'auto' && STRINGS[c]) return c;
        // case-insensitive: the browser says "zh-cn" or "zh-CN", the table uses "zh-CN";
        // then the base language ("pt-PT" -> "pt-BR", "de-AT" -> "de")
        const keys = Object.keys(STRINGS);
        const list = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
        for (const l of list) {
            const lc = String(l).toLowerCase(), base = lc.split('-')[0];
            const hit = keys.find((k) => k.toLowerCase() === lc) || keys.find((k) => k.toLowerCase().split('-')[0] === base);
            if (hit) return hit;
        }
        return 'en';
    }
    function fillVars(s, vars) {
        return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));
    }
    function lookup(key) {
        const lang = uiLang();
        let s = STRINGS[lang] && STRINGS[lang][key];
        if (s === undefined) s = STRINGS.en[key];
        if (s === undefined) { warn(`i18n: missing key ${key}`); s = key; }
        return { s, lang };
    }
    function i18n(key, vars) {
        const { s } = lookup(key);
        return fillVars(typeof s === 'object' ? (s.other || s.one) : s, vars);
    }
    function i18nN(key, n, vars) {
        const { s, lang } = lookup(key);
        if (typeof s !== 'object') return fillVars(s, Object.assign({ n }, vars));
        let form = 'other';
        try { form = new Intl.PluralRules(lang).select(n); } catch (e) { form = n === 1 ? 'one' : 'other'; }
        return fillVars(s[form] || s.other || s.one, Object.assign({ n }, vars));
    }


    // Z-up -> Y-up. Maps (x, y, z) -> (x, z, -y).
    const YUP = [
        1, 0, 0, 0,
        0, 0, -1, 0,
        0, 1, 0, 0,
        0, 0, 0, 1
    ];

    const TAG = '[Ripper]';
    function log(...args)  { console.log(TAG, ...args); }
    function warn(...args) { console.warn(TAG, ...args); }
    function err(...args)  { console.error(TAG, ...args); }

    log('init');

    // ====================================================================
    // Math
    // ====================================================================
    function identityMat4() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
    function mulMat4(a, b) {   // column-major a * b
        let r = new Array(16), c, rr, k;
        for (c = 0; c < 4; c++) for (rr = 0; rr < 4; rr++) {
            let v = 0;
            for (k = 0; k < 4; k++) v += a[k * 4 + rr] * b[c * 4 + k];
            r[c * 4 + rr] = v;
        }
        return r;
    }

    function matToArr(m) {
        if (!m || m.length !== 16) return null;
        const o = new Array(16);
        for (let i = 0; i < 16; i++) o[i] = m[i];
        return o;
    }

    function mat4Mul(a, b) {
        const o = new Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
            o[c*4+r] = a[0*4+r]*b[c*4+0] + a[1*4+r]*b[c*4+1]
                     + a[2*4+r]*b[c*4+2] + a[3*4+r]*b[c*4+3];
        }
        return o;
    }

    // Column-major 4x4 inverse. Returns null for a singular matrix (for example a bone scaled to 0).
    function invertMat4(m) {
        const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
        const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
        const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
        const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
        const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
        const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
        const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        let sc = 0;
        for (let i = 0; i < 12; i++) if (i % 4 !== 3) sc = Math.max(sc, Math.abs(m[i]));
        if (!isFinite(det) || Math.abs(det) <= 1e-12 * sc * sc * sc) return null;
        const id = 1 / det;
        return [
            (a11 * b11 - a12 * b10 + a13 * b09) * id, (a02 * b10 - a01 * b11 - a03 * b09) * id,
            (a31 * b05 - a32 * b04 + a33 * b03) * id, (a22 * b04 - a21 * b05 - a23 * b03) * id,
            (a12 * b08 - a10 * b11 - a13 * b07) * id, (a00 * b11 - a02 * b08 + a03 * b07) * id,
            (a32 * b02 - a30 * b05 - a33 * b01) * id, (a20 * b05 - a22 * b02 + a23 * b01) * id,
            (a10 * b10 - a11 * b08 + a13 * b06) * id, (a01 * b08 - a00 * b10 - a03 * b06) * id,
            (a30 * b04 - a31 * b02 + a33 * b00) * id, (a21 * b02 - a20 * b04 - a23 * b00) * id,
            (a11 * b07 - a10 * b09 - a12 * b06) * id, (a00 * b09 - a01 * b07 + a02 * b06) * id,
            (a31 * b01 - a30 * b03 - a32 * b00) * id, (a20 * b03 - a21 * b01 + a22 * b00) * id
        ];
    }

    // Confirmed from OSG source: MatrixTransform stores local transform
    // in `.matrix` and exposes it via `getMatrix()`.
    function getLocalNodeMatrix(node) {
        if (!node) return identityMat4();
        if (typeof node.getMatrix === 'function') {
            try {
                const m1 = matToArr(node.getMatrix());
                if (m1) return m1;
            } catch (e) {}
        }
        if (node.matrix) {
            const m2 = matToArr(node.matrix);
            if (m2) return m2;
        }
        if (node._matrix) {
            const m3 = matToArr(node._matrix);
            if (m3) return m3;
        }
        return identityMat4();
    }

    function computeWorldMatrix(obj) {
        const chain = [];
        let curr = obj;
        let guard = 0;
        while (curr && guard++ < 64) {
            chain.unshift(getLocalNodeMatrix(curr));
            curr = curr._parents && curr._parents[0];
        }
        let world = identityMat4();
        for (let i = 0; i < chain.length; i++) world = mat4Mul(world, chain[i]);
        return world;
    }

    // ====================================================================
    // Sheared joint matrices: M = T * U * diag(s) * Vt (exact for any 3x3), stored as two glTF nodes
    // ====================================================================
    function _mat3FromMat4(m) { return [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]]; }
    function _quatFromCols(c0, c1, c2) {
        // c0..c2: columns of a proper rotation matrix -> quaternion via decomposeMat4
        return decomposeMat4([c0[0], c0[1], c0[2], 0, c1[0], c1[1], c1[2], 0, c2[0], c2[1], c2[2], 0, 0, 0, 0, 1]).rotation;
    }
    function _cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
    function _dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    function _norm(a) { const l = Math.sqrt(_dot(a, a)); return l > 1e-20 ? [a[0] / l, a[1] / l, a[2] / l] : null; }
    function _anyPerp(a) {
        const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        return _norm(_cross(a, t));
    }
    // Symmetric 3x3 eigen decomposition (cyclic Jacobi). Returns eigenvalues and eigenvector columns.
    function _eigSym3(S) {
        const a = [[S[0][0], S[0][1], S[0][2]], [S[1][0], S[1][1], S[1][2]], [S[2][0], S[2][1], S[2][2]]];
        let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], sweep, p, q, r;
        for (sweep = 0; sweep < 50; sweep++) {
            const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
            if (off < 1e-30) break;
            for (p = 0; p < 2; p++) for (q = p + 1; q < 3; q++) {
                if (Math.abs(a[p][q]) < 1e-300) continue;
                const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
                const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
                const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
                for (r = 0; r < 3; r++) { const arp = a[r][p], arq = a[r][q]; a[r][p] = c * arp - sn * arq; a[r][q] = sn * arp + c * arq; }
                for (r = 0; r < 3; r++) { const apr = a[p][r], aqr = a[q][r]; a[p][r] = c * apr - sn * aqr; a[q][r] = sn * apr + c * aqr; }
                for (r = 0; r < 3; r++) { const vrp = v[r][p], vrq = v[r][q]; v[r][p] = c * vrp - sn * vrq; v[r][q] = sn * vrp + c * vrq; }
            }
        }
        return { vals: [a[0][0], a[1][1], a[2][2]], vecs: [[v[0][0], v[1][0], v[2][0]], [v[0][1], v[1][1], v[2][1]], [v[0][2], v[1][2], v[2][2]]] };
    }
    // m: column-major 4x4. prevV: previous frame's V columns (for continuity) or null.
    // Returns { translation, rotU, scale, rotV, V } with M = T * U * diag(scale) * V^T.
    function svdDecompose(m, prevV) {
        let A = _mat3FromMat4(m), i, j, k;
        const ATA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) for (k = 0; k < 3; k++) ATA[i][j] += A[k][i] * A[k][j];
        const e = _eigSym3(ATA), order = [0, 1, 2];
        order.sort((x, y) => e.vals[y] - e.vals[x]);
        let V = [e.vecs[order[0]], e.vecs[order[1]], e.vecs[order[2]]];
        const lmax = Math.max(e.vals[0], e.vals[1], e.vals[2]), lmin = Math.min(e.vals[0], e.vals[1], e.vals[2]);
        if (prevV) {
            // Two equal singular values: any basis of that plane is exact; use the one closest to the previous frame.
            const sv = [e.vals[order[0]], e.vals[order[1]], e.vals[order[2]]], gtol = 1e-4 * Math.max(lmax, 1e-30);
            const pa = (sv[0] - sv[1] <= gtol && sv[1] - sv[2] > gtol) ? 0 : ((sv[1] - sv[2] <= gtol && sv[0] - sv[1] > gtol) ? 1 : -1);
            if (pa >= 0) {
                let pc = V[pa === 0 ? 2 : 0], pr = null, bl = -1;
                for (i = 0; i < 3; i++) {
                    const dp = _dot(prevV[i], pc), pj = [prevV[i][0] - dp * pc[0], prevV[i][1] - dp * pc[1], prevV[i][2] - dp * pc[2]];
                    if (_dot(pj, pj) > bl) { bl = _dot(pj, pj); pr = pj; }
                }
                const va = _norm(pr);
                if (va) { V[pa] = va; V[pa + 1] = _cross(pc, va); }
            }
        }
        if (prevV && lmax - lmin <= 1e-6 * Math.max(lmax, 1e-30)) {
            V = [prevV[0], prevV[1], prevV[2]];   // uniform scale: any basis works, keep the previous one (no jump)
        } else if (prevV) {
            // Keep the same column order and signs as the previous frame (no flips during interpolation).
            const used = [false, false, false], nv = [];
            for (i = 0; i < 3; i++) {
                let best = -1, bd = -1;
                for (j = 0; j < 3; j++) { if (used[j]) continue; const dd = Math.abs(_dot(prevV[i], V[j])); if (dd > bd) { bd = dd; best = j; } }
                used[best] = true;
                nv.push(_dot(prevV[i], V[best]) < 0 ? [-V[best][0], -V[best][1], -V[best][2]] : V[best]);
            }
            V = nv;
        }
        if (_dot(_cross(V[0], V[1]), V[2]) < 0) V[2] = [-V[2][0], -V[2][1], -V[2][2]];
        let sig = [], U = [], smax = 0;
        for (i = 0; i < 3; i++) {
            const av = [A[0][0] * V[i][0] + A[0][1] * V[i][1] + A[0][2] * V[i][2],
                      A[1][0] * V[i][0] + A[1][1] * V[i][1] + A[1][2] * V[i][2],
                      A[2][0] * V[i][0] + A[2][1] * V[i][1] + A[2][2] * V[i][2]];
            sig[i] = Math.sqrt(_dot(av, av));
            if (sig[i] > smax) smax = sig[i];
            U[i] = av;
        }
        const ok = [];
        for (i = 0; i < 3; i++) { ok[i] = sig[i] > 1e-9 * Math.max(smax, 1e-30); U[i] = ok[i] ? [U[i][0] / sig[i], U[i][1] / sig[i], U[i][2] / sig[i]] : null; if (!ok[i]) sig[i] = 0; }
        // Complete / orthonormalise U (Gram-Schmidt in V order). A zero axis is rebuilt from the two real ones.
        if (!U[0] && U[1] && U[2]) U[0] = _cross(U[1], U[2]);
        else if (U[0] && !U[1] && U[2]) U[1] = _cross(U[2], U[0]);
        if (!U[0]) U[0] = U[1] ? _anyPerp(U[1]) : (U[2] ? _anyPerp(U[2]) : [1, 0, 0]);
        if (U[1]) { const d01 = _dot(U[1], U[0]); U[1] = _norm([U[1][0] - d01 * U[0][0], U[1][1] - d01 * U[0][1], U[1][2] - d01 * U[0][2]]); }
        if (!U[1]) U[1] = _anyPerp(U[0]);
        const u2 = _cross(U[0], U[1]);
        if (U[2] && _dot(U[2], u2) < 0) { sig[2] = -sig[2]; }   // mirrored: keep U a rotation, move the sign into scale
        U[2] = u2;
        return {
            translation: [m[12], m[13], m[14]],
            rotU: _quatFromCols(U[0], U[1], U[2]),
            scale: sig,
            // V^T as a rotation: its columns are the rows of V-as-columns
            rotV: _quatFromCols([V[0][0], V[1][0], V[2][0]], [V[0][1], V[1][1], V[2][1]], [V[0][2], V[1][2], V[2][2]]),
            V,
            uniform: lmax - lmin <= 1e-6 * Math.max(lmax, 1e-30)
        };
    }
    // SVD for a whole frame sequence: start at the first non-uniform frame (its basis is meaningful),
    // go forward from there, then backward for the leading uniform frames, so no frame picks a random basis.
    function svdSequence(mats) {
        let n = mats.length, out = new Array(n), k = 0, i;
        while (k < n && svdDecompose(mats[k], null).uniform) k++;
        if (k >= n) k = 0;
        out[k] = svdDecompose(mats[k], null);
        for (i = k + 1; i < n; i++) out[i] = svdDecompose(mats[i], out[i - 1].V);
        for (i = k - 1; i >= 0; i--) out[i] = svdDecompose(mats[i], out[i + 1].V);
        return out;
    }
    function _quatCont(q, prev) {
        if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) return [-q[0], -q[1], -q[2], -q[3]];
        return q;
    }
    function trsError(m) {
        let dc = composeTRS(decomposeMat4(m)), de = 0, dsc = 1e-9, dq;
        for (dq = 0; dq < 11; dq++) { if (dq % 4 === 3) continue; de = Math.max(de, Math.abs(dc[dq] - m[dq])); dsc = Math.max(dsc, Math.abs(m[dq])); }   // 3x3 part only: translation round-trips exactly
        return de / dsc;
    }

    // Inverse of decomposeMat4: column-major T*R*S matrix (used to measure decomposition error).
    function composeTRS(d) {
        const x = d.rotation[0], y = d.rotation[1], z = d.rotation[2], w = d.rotation[3], s = d.scale, t = d.translation;
        return [
            (1 - 2 * (y * y + z * z)) * s[0], (2 * (x * y + z * w)) * s[0], (2 * (x * z - y * w)) * s[0], 0,
            (2 * (x * y - z * w)) * s[1], (1 - 2 * (x * x + z * z)) * s[1], (2 * (y * z + x * w)) * s[1], 0,
            (2 * (x * z + y * w)) * s[2], (2 * (y * z - x * w)) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
            t[0], t[1], t[2], 1
        ];
    }

    function decomposeMat4(m) {
        const tx = m[12], ty = m[13], tz = m[14];
        let sx = Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]);
        const sy = Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]);
        const sz = Math.sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]);
        const iX = sx ? 1/sx : 0, iY = sy ? 1/sy : 0, iZ = sz ? 1/sz : 0;

        let m00 = m[0]*iX, m01 = m[4]*iY, m02 = m[8]*iZ;
        let m10 = m[1]*iX, m11 = m[5]*iY, m12 = m[9]*iZ;
        let m20 = m[2]*iX, m21 = m[6]*iY, m22 = m[10]*iZ;
        // A zero-scaled axis (rigs hide unused expression parts this way) leaves an empty column:
        // rebuild it from the other two so the rotation stays valid; keep the 0 scale.
        if (!sx && sy && sz) { m00 = m11 * m22 - m21 * m12; m10 = m21 * m02 - m01 * m22; m20 = m01 * m12 - m11 * m02; }
        else if (!sy && sx && sz) { m01 = m12 * m20 - m22 * m10; m11 = m22 * m00 - m02 * m20; m21 = m02 * m10 - m12 * m00; }
        else if (!sz && sx && sy) { m02 = m10 * m21 - m20 * m11; m12 = m20 * m01 - m00 * m21; m22 = m00 * m11 - m10 * m01; }
        else if ((!sx ? 1 : 0) + (!sy ? 1 : 0) + (!sz ? 1 : 0) === 2) {
            // One axis left: keep its direction, complete the rotation with any perpendicular pair.
            const c0 = sx ? [m00, m10, m20] : (sy ? [m01, m11, m21] : [m02, m12, m22]), c1 = _anyPerp(c0), c2 = _cross(c0, c1);
            if (sx) { m01 = c1[0]; m11 = c1[1]; m21 = c1[2]; m02 = c2[0]; m12 = c2[1]; m22 = c2[2]; }
            else if (sy) { m02 = c1[0]; m12 = c1[1]; m22 = c1[2]; m00 = c2[0]; m10 = c2[1]; m20 = c2[2]; }
            else { m00 = c1[0]; m10 = c1[1]; m20 = c1[2]; m01 = c2[0]; m11 = c2[1]; m21 = c2[2]; }
        } else if (!sx && !sy && !sz) { m00 = 1; m01 = 0; m02 = 0; m10 = 0; m11 = 1; m12 = 0; m20 = 0; m21 = 0; m22 = 1; }
        // Mirrored transform (negative determinant): move the reflection into the X scale.
        const det = m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20);
        if (det < 0) { sx = -sx; m00 = -m00; m10 = -m10; m20 = -m20; }

        const trace = m00 + m11 + m22;
        let qw, qx, qy, qz;

        if (trace > 0) {
            const S = Math.sqrt(trace + 1) * 2;
            qw = 0.25 * S;
            qx = (m21 - m12) / S;
            qy = (m02 - m20) / S;
            qz = (m10 - m01) / S;
        } else if (m00 > m11 && m00 > m22) {
            const S1 = Math.sqrt(1 + m00 - m11 - m22) * 2;
            qw = (m21 - m12) / S1;
            qx = 0.25 * S1;
            qy = (m01 + m10) / S1;
            qz = (m02 + m20) / S1;
        } else if (m11 > m22) {
            const S2 = Math.sqrt(1 + m11 - m00 - m22) * 2;
            qw = (m02 - m20) / S2;
            qx = (m01 + m10) / S2;
            qy = 0.25 * S2;
            qz = (m12 + m21) / S2;
        } else {
            const S3 = Math.sqrt(1 + m22 - m00 - m11) * 2;
            qw = (m10 - m01) / S3;
            qx = (m02 + m20) / S3;
            qy = (m12 + m21) / S3;
            qz = 0.25 * S3;
        }
        const ql = Math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw);
        if (ql) { qx /= ql; qy /= ql; qz /= ql; qw /= ql; }
        return {
            translation: [tx, ty, tz],
            rotation: [qx, qy, qz, qw],
            scale: [sx, sy, sz]
        };
    }

    // ====================================================================
    // Texture capture
    // ====================================================================
    const _usedTextureNames = {};

    function sanitizeTextureName(raw) {
        if (!raw) return '';
        let s = String(raw);
        try { s = decodeURIComponent(s); } catch (e) {}
        s = s.replace(/\.(jpe?g|png|webp|gif|ktx2?|basis|tga|bmp)$/i, '');
        s = s.replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_').trim();
        return s;
    }

    function deriveTextureName(url) {
        if (!url) return 'texture';
        const clean = String(url).split('?')[0].split('#')[0];
        const base = clean.substring(clean.lastIndexOf('/') + 1);
        const s = sanitizeTextureName(base);
        return s || 'texture';
    }

    function pickTextureName(imagemodel, url) {
        // Prefer Sketchfab's metadata name (semantic, e.g.
        // "Patriot_Radar_Body_D_Desert"). Fall back to URL base if
        // metadata is missing or empty.
        const metaName = imagemodel && imagemodel.attributes && imagemodel.attributes.name;
        const s = sanitizeTextureName(metaName);
        if (s) return s;
        return deriveTextureName(url);
    }

    function normalizeUrl(u) {
        if (!u) return '';
        return String(u).split('?')[0].split('#')[0].replace(/\/+$/, '');
    }

    // Read Sketchfab's per-mesh channel -> source-texture mapping.
    // Structure: obj.stateset._textureAttributeArrayList = [
    //   [ AttributePair{_object: Texture} ],   // slot 0
    //   [ AttributePair{_object: Texture} ],   // slot 1
    //   ...
    // ]
    // Each Texture has:
    //   _channels      = ['AlbedoPBR','GlossinessPBR'] etc.
    //   _packedTextures = { AlbedoPBR: {texture: {_image, _imageModel}}, ... }
    // The mesh's own stateset normally carries the textures (Patriot). On some
    // models (the Kalibr) the mesh has no stateset and its material sits on the
    // parent node named after the material, so walk up to the first stateset
    // that has texture slots. The mesh's own stateset always wins when it has them.
    function textureStateSet(obj) {
        function hasTex(ss) {
            const ta = ss && ss._textureAttributeArrayList;
            if (!ta || !ta.length) return false;
            for (let i = 0; i < ta.length; i++) if (ta[i] && ta[i][0]) return true;
            return false;
        }
        if (!obj) return null;
        if (hasTex(obj.stateset)) return obj.stateset;
        let cur = obj._parents && obj._parents[0], guard = 0;
        while (cur && guard++ < 8) {
            if (hasTex(cur.stateset)) return cur.stateset;
            cur = cur._parents && cur._parents[0];
        }
        return obj.stateset || null;
    }

    // Sketchfab keeps each material's flat channel values in a material model:
    // stateset._attributeArray[0]._materialModel.attributes.channels.<Name>.attributes
    // ({ enable, factor, color }). The stateset can sit on an ancestor of the mesh.
    function getMaterialChannels(obj) {
        function unwrap(w) { return w && (w._object || w.attribute || w._attribute || w); }
        let cur = obj, guard = 0;
        while (cur && guard++ < 8) {
            const ss = cur.stateset || cur._stateSet || null;
            const a0 = unwrap(ss && ss._attributeArray && ss._attributeArray[0]);
            const mm = a0 && a0._materialModel;
            const ch = mm && mm.attributes && mm.attributes.channels;
            if (ch) {
                const out = {};
                for (let k in ch) {
                    if (!ch.hasOwnProperty(k)) continue;
                    const at = ch[k] && ch[k].attributes;
                    if (at) out[k] = at;
                }
                // Which channels have a texture: the stateset's channel mapping (>= 0 = texture unit).
                out.__map = a0._channelMapping || null;
                out.__cull = mm.attributes.cullFace;   // 0 = Single Sided OFF; ON value to be confirmed from logs
                return out;
            }
            cur = cur._parents && cur._parents[0];
        }
        return null;
    }

    function getChannelTextureMap(obj) {
        const map = {};
        try {
            const ss = textureStateSet(obj);
            if (!ss) return map;
            const ta = ss._textureAttributeArrayList;
            if (!ta || !ta.length) return map;
            for (let s = 0; s < ta.length; s++) {
                const slot = ta[s];
                if (!slot || !slot[0]) continue;
                const tex = slot[0]._object;
                if (!tex) continue;
                const channels = tex._channels || [];
                const packedAll = tex._packedTextures || {};
                for (let c = 0; c < channels.length; c++) {
                    const chName = channels[c];
                    if (!chName) continue;
                    const packed = packedAll[chName];
                    if (!packed || !packed.texture) continue;
                    const img = packed.texture._image;
                    const imM = packed.texture._imageModel;
                    map[chName] = {
                        url : img && (img._url || img.url),
                        name: imM && imM.attributes && imM.attributes.name,
                        // Texture-less materials: Sketchfab packs the flat colours into a generated
                        // colour atlas (no image file); the channel then only looks textured.
                        atlas: (packed.texture._isColorAtlas === true || tex._isColorAtlas === true)
                    };
                }
            }
        } catch (e) { warn('getChannelTextureMap', e.message); }
        return map;
    }

    window.drawhookcanvas = (e, imagemodel) => {
        try {
            if (!e) return e;
            // 32/64/128 px square images are usually low-res placeholders of a bigger texture; they are
            // skipped only while a larger variant exists (a texture whose real size is 128 px is kept).
            const isSmall = (e.width === 128 && e.height === 128) ||
                          (e.width === 32  && e.height === 32)  ||
                          (e.width === 64  && e.height === 64);
            if (isSmall && !(imagemodel && e.options && imagemodel.attributes && imagemodel.attributes.images)) return e;
            if (imagemodel && e.options && imagemodel.attributes && imagemodel.attributes.images) {
                const alpha = e.options.format;
                let url_image = e.url, max_size = 0, obr = e;
                imagemodel.attributes.images.forEach((img) => {
                    const ok = alpha === 'A' ? img.options.format === alpha : true;
                    let d = img.width; while (d > 0 && d % 2 === 0) d = d / 2;
                    if (img.size > max_size && ok && d === 1) {
                        max_size = img.size; url_image = img.url; obr = img;
                    }
                });
                if (isSmall && !(obr && obr.width <= e.width)) return e;   // a larger variant will come
                if (!saveimagecache2[url_image]) {
                    const base = pickTextureName(imagemodel, url_image);
                    let texName = base, n = 1;
                    while (_usedTextureNames[texName]) texName = `${base}_${n++}`;
                    _usedTextureNames[texName] = true;
                    saveimagecache2[url_image] = { name: texName };
                }
                return obr;
            }
        } catch (e2) { warn('drawhookcanvas', e2.message); }
        return e;
    };

    window.drawhookimg = (gl, t) => {
        try {
            const url = t[5].currentSrc, width = t[5].width, height = t[5].height;
            if (!saveimagecache2[url]) return;
            if (saveimagecache2[url].dataURL) return;
            const data = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
            const hh = height / 2 | 0, bpr = width * 4, temp = new Uint8Array(width * 4);
            for (let y = 0; y < hh; ++y) {
                const t0 = y * bpr, b0 = (height - y - 1) * bpr;
                temp.set(data.subarray(t0, t0 + bpr));
                data.copyWithin(t0, b0, b0 + bpr);
                data.set(temp, b0);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d');
            const id = ctx.createImageData(width, height);
            id.data.set(data);
            ctx.putImageData(id, 0, 0);
            const isJpeg = /\.(jpe?g)(?:\?|$)/i.test(url);
            const mime   = isJpeg ? 'image/jpeg' : 'image/png';
            const ext    = isJpeg ? '.jpg' : '.png';
            const q      = isJpeg ? 0.92 : undefined;
            const name   = saveimagecache2[url].name + ext;
            saveimagecache2[url].fileExt = ext;
            saveimagecache2[url].dataURL = true;   // capture flag only (a base64 copy was never read)
            canvas.toBlob((b) => { objects[name] = b; }, mime, q);
        } catch (e) { warn('drawhookimg', e.message); }
    };

    // ====================================================================
    // attachbody
    // ====================================================================
    function geomKey(o, noIndices) {
        const v = o && o._attributes && o._attributes.Vertex && o._attributes.Vertex._elements;
        if (!v || !v.length) return '';
        let n = v.length, parts = [n], k;
        for (k = 0; k < 16; k++) parts.push(v[Math.floor(k * (n - 1) / 15)]);
        if (!noIndices) {
            const pr = o._primitives && o._primitives[0];
            parts.push(pr && pr.indices && pr.indices._elements ? pr.indices._elements.length : -1);
        }
        return parts.join(',');
    }

    // The viewer can hold a second copy of a mesh that only has LINES (its wireframe display).
    // It has the same vertices as the real mesh but no triangles. Returns the index of the real
    // mesh when obj is such an overlay, otherwise -1. A line mesh with no twin is real and is kept.
    function wireOverlayTwin(list, idx) {
        let obj = list[idx], prims = obj && obj._primitives, i, p, hasLines = false, key;
        if (!prims || !prims.length) return -1;
        for (i = 0; i < prims.length; i++) {
            p = prims[i];
            if (!p || !p.indices) continue;
            if (p.mode === 1 || p.mode === 2 || p.mode === 3) hasLines = true;
            else return -1;   // has a triangle (or point) primitive: not an overlay
        }
        if (!hasLines) return -1;
        key = geomKey(obj, true);
        if (!key) return -1;
        for (i = 0; i < list.length; i++) {
            let o2 = list[i], pr2 = o2 && o2._primitives, j, tri = false;
            if (i === idx || !pr2 || geomKey(o2, true) !== key) continue;
            for (j = 0; j < pr2.length; j++) {
                const m2 = pr2[j] && pr2[j].mode;
                if (pr2[j] && pr2[j].indices && (m2 === undefined || m2 === null || m2 === 4 || m2 === 5 || m2 === 6)) tri = true;
            }
            if (tri) return i;
        }
        return -1;
    }

    // Keyframe reduction. Keeps the first and last key, and every key that is needed so that
    // interpolation between the kept keys stays within tol of each recorded sample (per component).
    // Rotations (isQuat) are checked with slerp, as glTF interpolates them. A segment spans at most
    // maxSpan recorded frames, which limits the run time. Returns the indices of the kept keys.
    function reduceKeys(times, vals, n, tol, isQuat, maxSpan) {
        let nk = times.length, keep = [0], i = 0, j, k, c, ok, best, tmp = [0, 0, 0, 0];
        if (nk < 3) { for (k = 1; k < nk; k++) keep.push(k); return keep; }
        function interp(a, b, u) {
            const ia = a * n, ib = b * n;
            if (isQuat && n === 4) {
                let dt = vals[ia] * vals[ib] + vals[ia + 1] * vals[ib + 1] + vals[ia + 2] * vals[ib + 2] + vals[ia + 3] * vals[ib + 3];
                let sg = dt < 0 ? -1 : 1, w0, w1;
                dt = Math.abs(dt);
                if (dt > 0.9995) { w0 = 1 - u; w1 = u; }
                else {
                    const th = Math.acos(Math.min(1, dt)), sn = Math.sin(th);
                    w0 = Math.sin((1 - u) * th) / sn; w1 = Math.sin(u * th) / sn;
                }
                let len = 0;
                for (c = 0; c < 4; c++) { tmp[c] = w0 * vals[ia + c] + sg * w1 * vals[ib + c]; len += tmp[c] * tmp[c]; }
                len = Math.sqrt(len) || 1;
                for (c = 0; c < 4; c++) tmp[c] /= len;
            } else {
                for (c = 0; c < n; c++) tmp[c] = vals[ia + c] + (vals[ib + c] - vals[ia + c]) * u;
            }
        }
        while (i < nk - 1) {
            best = i + 1;
            for (j = i + 2; j < nk && j - i <= maxSpan; j++) {
                ok = true;
                const span = times[j] - times[i];
                for (k = i + 1; k < j && ok; k++) {
                    interp(i, j, span > 0 ? (times[k] - times[i]) / span : 0);
                    for (c = 0; c < n; c++) if (Math.abs(tmp[c] - vals[k * n + c]) > tol) { ok = false; break; }
                }
                if (!ok) break;
                best = j;
            }
            keep.push(best);
            i = best;
        }
        return keep;
    }

    // Remove nodes (the skipped wireframe overlay) and renumber every reference to a node.
    // Changes the list in place and returns the new index of the scene root.
    function removeNodes(nodes, skins, animations, drop, rootIdx) {
        let remap = [], kept = [], i;
        for (i = 0; i < nodes.length; i++) {
            if (drop[i]) remap.push(-1);
            else { remap.push(kept.length); kept.push(nodes[i]); }
        }
        kept.forEach((n) => {
            if (!n.children) return;
            const c2 = [];
            n.children.forEach((c) => { if (remap[c] >= 0) c2.push(remap[c]); });
            n.children = c2;
        });
        skins.forEach((sk) => {
            sk.joints = sk.joints.map((j) => remap[j]);
            if (typeof sk.skeleton === 'number') sk.skeleton = remap[sk.skeleton];
        });
        (animations || []).forEach((a) => {
            a.channels.forEach((c) => {
                if (c.target && typeof c.target.node === 'number') c.target.node = remap[c.target.node];
            });
        });
        nodes.length = 0;
        kept.forEach((n) => { nodes.push(n); });
        return remap[rootIdx];
    }

    window.attachbody = (obj) => {
        try {
            if (!obj || obj._faked === true) return;
            const name = obj._name;
            const ssName = obj.stateset && obj.stateset._name;
            const pName = (obj._parents && obj._parents.length > 0 && obj._parents[0] && obj._parents[0]._name) || null;
            if (!name && !ssName && !pName) return;
            obj._faked = true;
            if (name === 'composer layer' || name === 'Ground - Geometry') return;
            
            // Dedupe: viewer re-instantiates meshes when WebGL contexts
            // get recycled. A new obj has _faked = false again, so the
            // basic guard doesn't catch it. Merge by name + vertex count.
            // M_Patriot_Radar_Tires legitimately appears twice with
            // DIFFERENT vertex counts, so this won't merge them.
            const displayName = ssName || name || '';
            const vcount = (obj._attributes && obj._attributes.Vertex &&
                        obj._attributes.Vertex._elements)
                        ? obj._attributes.Vertex._elements.length : 0;
            // Name + vertex count alone is not enough: big models are split into unnamed chunks that
            // often have the same vertex count (e.g. 65532), so also compare sampled vertex data.
            const gk = geomKey(obj);
            for (let i = 0; i < window.allmodel.length; i++) {
                const ex = window.allmodel[i];
                if (!ex) continue;
                const exName = (ex.stateset && ex.stateset._name) || ex._name || '';
                if (exName !== displayName) continue;
                const exVcount = (ex._attributes && ex._attributes.Vertex &&
                                ex._attributes.Vertex._elements)
                            ? ex._attributes.Vertex._elements.length : 0;
                if (exVcount === vcount && geomKey(ex) === gk) {
                    // Same name + vertex count but a different world position may be a
                    // genuine second instance (e.g. repeated parts), not a re-instantiation.
                    // Animated parents also move a mesh, so by default this only warns and
                    // still merges (unchanged behaviour). Set DEDUPE_STRICT_WORLD to keep both.
                    let wNew = computeWorldMatrix(obj), wEx = computeWorldMatrix(ex), wd = 0;
                    for (let wi = 12; wi < 15; wi++) wd = Math.max(wd, Math.abs(wNew[wi] - wEx[wi]));
                    if (wd > 1e-3) {
                        warn('attachbody: "' + displayName + '" matches an existing mesh but sits ' +
                             wd.toFixed(4) + ' away; ' +
                             (CONFIG.DEDUPE_STRICT_WORLD ? 'keeping both' : 'merging (DEDUPE_STRICT_WORLD off)'));
                        if (CONFIG.DEDUPE_STRICT_WORLD) continue;
                    }
                    // Replace so the latest instance (with live palette)
                    // is what we read from during recording.
                    window.allmodel[i] = obj;
                    return;
                }
            }
            window.allmodel.push(obj);
        } catch (e) { err('attachbody', e.message); }
    };

    // ====================================================================
    // Recorder
    // ====================================================================
    // Morph targets: the viewer keeps target k's absolute vertex data in attribute
    // Vertex_k (Normal_k) and the live blend weights in obj._targetWeights.
    function morphTargetCount(obj) {
        let attr = obj && obj._attributes, n = 0;
        if (!attr) return 0;
        for (let k in attr) {
            if (!attr.hasOwnProperty(k)) continue;
            const m = /^Vertex_(\d+)$/.exec(k);
            if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
        }
        return n;
    }

    function unitNormals(a) {
        let o = new Float32Array(a.length), i, x, y, z, l;
        for (i = 0; i + 2 < a.length; i += 3) {
            x = a[i]; y = a[i + 1]; z = a[i + 2];
            l = Math.sqrt(x * x + y * y + z * z);
            if (l > 1e-12) { o[i] = x / l; o[i + 1] = y / l; o[i + 2] = z / l; }
            else { o[i] = 0; o[i + 1] = 1; o[i + 2] = 0; }
        }
        return o;
    }

    function snapshotFrame() {
        const meshesOut = [];
        window.allmodel.forEach((obj) => {
            const world = computeWorldMatrix(obj);
            let wts = null;
            try {
                const nT = morphTargetCount(obj);
                if (nT && obj._targetWeights) {
                    wts = new Float32Array(nT);
                    for (let wi = 0; wi < nT; wi++) wts[wi] = obj._targetWeights[wi] || 0;
                }
            } catch (e) {}
            let pal = null;
            try {
                const impl = obj._rigTransformImplementation;
                if (impl && impl._skinningAttribute && impl._skinningAttribute._matrixPalette) {
                    const src = impl._skinningAttribute._matrixPalette;
                    pal = new Float32Array(src.length);
                    for (let i = 0; i < src.length; i++) pal[i] = src[i];
                }
            } catch (e) {}
            meshesOut.push({ world, palette: pal, weights: wts });
        });
        return { meshes: meshesOut };
    }

    // ====================================================================
    // Bone hierarchy from the osgjs rig
    // ====================================================================
    // RigTransformHardware: palette[i] = invT * boneWorld_i * invBind_i * T (T: skeleton to geometry space).
    // The joints are written in skeleton space: skeleton root node = meshWorld * invT, IBM_i = invBind_i * T,
    // joint matrix G_i = T * palette_i * inverse(IBM_i) = boneWorld_i. Each joint node gets G_i relative to its
    // parent joint, which is the bone's own local matrix in the viewer, so the export has real bones, parents,
    // names and a bind pose. Returns { fail: reason } when the rig cannot be read or the check fails.
    function palMat4(pal, i) {   // one 3x4 row-major palette entry -> column-major 4x4
        const b = i * 12;
        return [pal[b], pal[b + 4], pal[b + 8], 0, pal[b + 1], pal[b + 5], pal[b + 9], 0,
                pal[b + 2], pal[b + 6], pal[b + 10], 0, pal[b + 3], pal[b + 7], pal[b + 11], 1];
    }
    function callOr(o, fn, field) {
        try { if (o && typeof o[fn] === 'function') { const v = o[fn](); if (v) return v; } } catch (e) {}
        return o ? o[field] : undefined;
    }
    function getRigInfo(obj, nJ) {
        const impl = obj && obj._rigTransformImplementation;
        if (!impl) return { fail: 'no rig implementation' };
        const isBone = (b) => !!(b && (typeof b.getInvBindMatrixInSkeletonSpace === 'function' || b._invBindInSkeletonSpace));
        const cands = [impl._bonePalette, callOr(impl, 'getBonePalette', '_bonePalette')];
        Object.keys(impl).forEach((k) => { cands.push(impl[k]); });
        let bones = null;
        for (const c of cands) if (Array.isArray(c) && c.length && c.every(isBone)) { bones = c; break; }
        if (!bones) return { fail: `no bone list (rig fields: ${Object.keys(impl).join(',')})` };
        if (bones.length < nJ) return { fail: `bone list has ${bones.length} bones, palette has ${nJ}` };
        const T = matToArr(callOr(obj, 'getMatrixFromSkeletonToGeometry', '_matrixFromSkeletonToGeometry')) || identityMat4();
        const invT = matToArr(callOr(obj, 'getInvMatrixFromSkeletonToGeometry', '_invMatrixFromSkeletonToGeometry')) || invertMat4(T);
        if (!invT) return { fail: 'skeleton to geometry matrix is singular' };
        const index = new Map(), ibm = [], invIbm = [], parent = [], names = [], used = {};
        for (let i = 0; i < nJ; i++) index.set(bones[i], i);
        const live = impl._skinningAttribute && impl._skinningAttribute._matrixPalette;
        let chk = 0, chkJ = -1, nChk = 0;
        for (let i = 0; i < nJ; i++) {
            const b = bones[i];
            const ib = matToArr(callOr(b, 'getInvBindMatrixInSkeletonSpace', '_invBindInSkeletonSpace'));
            if (!ib) return { fail: `bone ${i} has no inverse bind matrix` };
            ibm.push(mulMat4(ib, T));
            const inv = invertMat4(ibm[i]);
            if (!inv) return { fail: `bone ${i} has a singular inverse bind matrix` };
            invIbm.push(inv);
            let p = b._parents && b._parents[0], g = 0, pi = -1;
            while (p && g++ < 256) {
                if (index.has(p)) { pi = index.get(p); break; }
                p = p._parents && p._parents[0];
            }
            parent.push(pi);
            let nm = String(callOr(b, 'getName', '_name') || `joint_${i}`), k = 2;
            const base = nm;
            while (used[nm]) nm = `${base}_${k++}`;
            used[nm] = true;
            names.push(nm);
            // Check the formula against the live palette of the viewer.
            const bw = matToArr(callOr(b, 'getMatrixInSkeletonSpace', '_boneInSkeletonSpace'));
            if (live && live.length >= (i + 1) * 12 && bw) {
                const P = palMat4(live, i), E = mulMat4(mulMat4(mulMat4(invT, bw), ib), T);
                let mx = 0, sc = 1;
                for (let q = 0; q < 16; q++) { mx = Math.max(mx, Math.abs(P[q] - E[q])); sc = Math.max(sc, Math.abs(P[q])); }
                if (mx / sc > chk) { chk = mx / sc; chkJ = i; }
                nChk++;
            }
        }
        if (nChk < nJ) return { fail: `palette check not possible for ${nJ - nChk} of ${nJ} bones` };
        if (chk > 1e-3) return { fail: `palette check failed (error ${chk.toExponential(2)} at bone ${chkJ})` };
        for (let i = 0; i < nJ; i++) {   // a parent loop would break the node tree
            let p = parent[i], g = 0;
            while (p >= 0 && g++ <= nJ) p = parent[p];
            if (p >= 0) return { fail: 'bone parents form a loop' };
        }
        return { bones: nJ, T, invT, ibm, invIbm, parent, names, check: chk, cache: new WeakMap() };
    }
    // Local joint matrices (relative to the parent joint) for one palette. Null when a parent joint
    // is singular (scaled to 0), because the local matrix of its child is then undefined.
    function rigLocals(rig, pal) {
        let L = rig.cache.get(pal);
        if (L !== undefined) return L;
        const G = [];
        for (let i = 0; i < rig.bones; i++) G.push(mulMat4(rig.T, mulMat4(palMat4(pal, i), rig.invIbm[i])));
        L = [];
        for (let i = 0; i < rig.bones; i++) {
            const p = rig.parent[i];
            if (p < 0) { L.push(G[i]); continue; }
            const ip = invertMat4(G[p]);
            if (!ip) { L = null; break; }
            L.push(mulMat4(ip, G[i]));
        }
        rig.cache.set(pal, L);
        return L;
    }

    // True when a frame at time t should be kept for the chosen RECORD_FPS (0 = keep every frame).
    function fpsDue(t, lastT) {
        const f = +CONFIG.RECORD_FPS || 0;
        return lastT < 0 || f <= 0 || t - lastT >= 1 / f - Math.min(0.004, 0.25 / f);   // tolerance for rAF jitter
    }

    // Single-clip RECORD with exactly one active clip: restart that clip and record
    // exactly one loop (0..duration) automatically. Returns false when that is not
    // possible, so the caller falls back to the manual timed recording.
    function startAutoSingleRecording() {
        const mgr = findAnimationManager();
        if (!mgr) return false;
        const act = activeClipUids(mgr);
        if (act.length !== 1) return false;
        const inst = mgr._instanceAnimations[act[0]];
        if (!inst || !(inst.duration > 0)) return false;
        const def = { uid: act[0], name: inst.name || act[0], duration: inst.duration };
        window.animationRecording = true;
        window.autoRecordActive = true;
        window.clipCancel = false;
        window.recordedFrames = [];
        if (window.clips && window.clips.length) {
            log(`single-clip record: discarded ${window.clips.length} stored multi-clip recording(s)`);
        }
        window.clips = [];
        setRecLabel(i18n('btn_stop'));
        const base = inst.start || 0;
        log(`auto record: one full loop of the active clip (${def.duration.toFixed(2)}s)`);
        progStage(1, 1, i18n('pr_recording', { name: def.name }));
        try { mgr.setSeekTime(base); } catch (e) {
            err('auto record seek', e.message);
            window.animationRecording = false; window.autoRecordActive = false; setRecLabel(i18n('btn_rec_single'));
            return false;
        }
        function done(frames) {
            window.animationRecording = false;
            window.autoRecordActive = false;
            window.clipCancel = false;
            setRecLabel(i18n('btn_rec_single'));
            if (frames && frames.length > 1) {
                window.recordedFrames = frames;
                log('recording stopped, frames:', frames.length);
                progDone(i18nN('pr_recorded_frames', frames.length));
            } else {
                warn('auto record produced no frames');
                progDone(i18n('pr_recording_failed'), true);
            }
        }
        waitFrames(CONFIG.CLIP_SETTLE_FRAMES, () => {
            try { recordClipRealtime(mgr, def, base, done); } catch (e) { err('auto record', e.message); done([]); }
        });
        return true;
    }

    function startRecording() {
        if (window.animationRecording || window.clipRecording) return;
        if (_exporting) { warn('export is running: wait for "export done" before recording'); return; }
        if (startAutoSingleRecording()) return;
        window.animationRecording = true;
        window.recordedFrames = [];
        // A fresh single-clip recording must win at export time. Stale multi-clip
        // data from an earlier RECORD ALL CLIPS run would otherwise override it.
        if (window.clips && window.clips.length) {
            log(`single-clip record: discarded ${window.clips.length} stored multi-clip recording(s)`);
        }
        window.clips = [];
        window.recordingStartTime = performance.now() / 1000;
        setRecLabel(i18n('btn_stop'));
        log(`recording started (max ${CONFIG.MAX_RECORD_SECONDS}s)`);
        progStage(1, 1, i18n('pr_recording_manual'));
        function tick() {
            if (!window.animationRecording) return;
            const t = performance.now() / 1000 - window.recordingStartTime;
            progSub(t / CONFIG.MAX_RECORD_SECONDS, i18n('pr_seconds', { t: t.toFixed(1), d: CONFIG.MAX_RECORD_SECONDS }));
            const rf = window.recordedFrames;
            if (fpsDue(t, rf.length ? rf[rf.length - 1].time : -1)) {
                rf.push({ time: t, meshes: snapshotFrame().meshes });
            }
            if (t >= CONFIG.MAX_RECORD_SECONDS) { stopRecording(); return; }
            window.recordingRafId = requestAnimationFrame(tick);
        }
        window.recordingRafId = requestAnimationFrame(tick);
    }

    function stopRecording() {
        if (!window.animationRecording) return;
        if (window.autoRecordActive) { window.clipCancel = true; return; }
        window.animationRecording = false;
        cancelAnimationFrame(window.recordingRafId);
        setRecLabel(i18n('btn_rec_single'));
        log('recording stopped, frames:', window.recordedFrames.length);
        progDone(i18nN('pr_recorded_frames', window.recordedFrames.length));
    }

    function setRecLabel(text) {
        const el = document.getElementById('recBtnLabel');
        if (el) el.textContent = text;
    }

    // ---------------- progress bars: stage (k of n) and sub-stage ----------------
    let _progHideTimer = null;
    function progStage(k, n, label) {
        const box = document.getElementById('ripper-progress');
        if (!box) return;
        clearTimeout(_progHideTimer);
        box.style.display = 'flex';
        box.classList.remove('rp-err');
        document.getElementById('rp-stage-fill').style.width = `${Math.round(100 * k / n)}%`;
        document.getElementById('rp-stage-label').textContent = `${k}/${n} ${label}`;
        progSub(0, '');
    }
    // frac < 0: work without a measurable fraction (striped bar)
    function progSub(frac, label) {
        const fill = document.getElementById('rp-sub-fill');
        if (!fill) return;
        const busy = frac < 0;
        fill.classList.toggle('rp-busy', busy);
        fill.style.width = busy ? '100%' : `${Math.round(100 * Math.max(0, Math.min(1, frac)))}%`;
        const l = document.getElementById('rp-sub-label');
        if (l) l.textContent = label || '';
    }
    function progDone(label, isErr) {
        const box = document.getElementById('ripper-progress');
        if (!box) return;
        box.classList.toggle('rp-err', !!isErr);
        document.getElementById('rp-stage-fill').style.width = '100%';
        document.getElementById('rp-stage-label').textContent = label;
        progSub(1, isErr ? i18n('pr_see_console') : '');
        clearTimeout(_progHideTimer);
        _progHideTimer = setTimeout(() => { box.style.display = 'none'; }, isErr ? 8000 : 3000);
    }

    // ====================================================================
    // Animation clips
    // ====================================================================
    let _clipMgrCache = null;

    function findAnimationManager() {
        if (_clipMgrCache && _clipMgrCache._instanceAnimations) return _clipMgrCache;
        let cur = window.allmodel[0], guard = 0;
        while (cur && guard++ < 64) {
            const cbs = cur._updateCallbacks || [];
            for (let i = 0; i < cbs.length; i++) {
                const c = cbs[i];
                if (c && c._instanceAnimations && typeof c.stopAllAnimation === 'function') {
                    _clipMgrCache = c;
                    return c;
                }
            }
            cur = cur._parents && cur._parents[0];
        }
        return null;
    }

    function getClipCount() {
        const mgr = findAnimationManager();
        return mgr ? Object.keys(mgr._instanceAnimations).length : 0;
    }

    function waitFrames(n, cb) {
        if (n <= 0) { cb(); return; }
        requestAnimationFrame(() => { waitFrames(n - 1, cb); });
    }

    function activeClipUids(mgr) {
        const out = [];
        const list = mgr._activeAnimationList || [];
        for (let i = 0; i < list.length; i++) out.push(list[i].name);
        return out;
    }

    // UI class names can change; try the known selector first, then looser ones.
    // Non-clip items are harmless: discovery skips any item that activates no clip.
    const CLIP_ITEM_SELECTORS = [
        '.animation-list .animation-item',
        '[class*="animation"][class*="list"] li',
        'li[class*="animation-item"]'
    ];

    function getClipItems() {
        for (let s = 0; s < CLIP_ITEM_SELECTORS.length; s++) {
            const found = document.querySelectorAll(CLIP_ITEM_SELECTORS[s]);
            if (found.length) return found;
        }
        return [];
    }

    // Click list item k (the viewer does its own stop/start) and wait.
    function selectClipItem(k, cb) {
        const items = getClipItems();
        if (!items[k]) { cb(false); return; }
        // Drain any start queued earlier (e.g. by a stray playAnimation call). The
        // manager flushes _startAnimations on its next update, and a leftover shows up
        // as an extra active clip. stopAllAnimation() does NOT clear this queue.
        const mgr = findAnimationManager();
        if (mgr && mgr._startAnimations) mgr._startAnimations = {};
        try { items[k].click(); } catch (e) { warn('clip item click', e.message); cb(false); return; }
        waitFrames(6, () => { cb(true); });
    }

    // Clicks every list item and reads which clip UID became active.
    // cb(defs, origIdx): defs = [{ index, uid, name, duration }];
    // origIdx = list item that was selected before discovery (restored at the end).
    function discoverAnimationClips(cb) {
        const mgr = findAnimationManager();
        const count = getClipItems().length;
        if (!mgr || !count) {
            warn(`clip discovery: manager=${!!mgr} listItems=${count}`);
            cb([], 0);
            return;
        }
        const origUid = activeClipUids(mgr)[0] || null;
        let defs = [], noClipIdx = -1, i = 0;

        function next() {
            if (i >= count) { finish(); return; }
            const k = i++;
            selectClipItem(k, (ok) => {
                if (!ok) { next(); return; }
                const li = getClipItems()[k];
                if (!li) { warn(`clip list item ${k} vanished during discovery, skipped`); next(); return; }
                const name = (li.textContent || '').trim().replace(/\s+/g, ' ');
                const act = activeClipUids(mgr);
                if (act.length === 1) {
                    const inst = mgr._instanceAnimations[act[0]];
                    defs.push({ index: k, uid: act[0], name,
                                duration: inst ? inst.duration : 0 });
                } else if (act.length === 0) {
                    noClipIdx = k;
                    log(`list item ${k} "${name}" has no clip (treated as the Static Pose item)`);
                } else {
                    warn(`list item ${k} "${name}" activated ${act.length} clips, skipped`);
                }
                next();
            });
        }

        function finish() {
            window.clipStaticIdx = noClipIdx;
            let origIdx = (noClipIdx >= 0) ? noClipIdx : 0;
            for (let d = 0; d < defs.length; d++) {
                if (defs[d].uid === origUid) { origIdx = defs[d].index; break; }
            }
            selectClipItem(origIdx, () => {
                window.clipDefs = defs;
                log(`discovered ${defs.length} clips`);
                for (let q = 0; q < defs.length; q++) {
                    log('clip ' + defs[q].index + ': ' + defs[q].name +
                        ' (' + defs[q].duration.toFixed(2) + 's)');
                }
                cb(defs, origIdx);
            });
        }
        next();
    }

    function recordClipRealtime(mgr, def, base, cb) {
        mgr.setSeekTime(base);
        if (mgr._pause) mgr.togglePause();
        // Frame times come from the manager's own clock (getSimulationTime) so they
        // match what the viewer is showing even if rAF drops frames or _timeFactor
        // is not 1. Falls back to wall-clock time if that clock is unavailable.
        const hasSimClock = typeof mgr.getSimulationTime === 'function';
        let wall0 = performance.now() / 1000, sim0 = null, lastT = -1, lastSeen = -1, frames = [];
        let useSim = hasSimClock;
        function clockNow() {
            if (useSim) {
                const s = mgr.getSimulationTime();
                if (typeof s === 'number' && isFinite(s)) {
                    if (sim0 === null) sim0 = s;
                    return s - sim0;
                }
                warn(`sim clock returned ${s}, falling back to wall clock`);
                useSim = false;
                wall0 = performance.now() / 1000 - (lastT > 0 ? lastT : 0);
            }
            return performance.now() / 1000 - wall0;
        }
        // Samples cover [0, duration). The closing frame at t = duration is a copy
        // of frame 0 (the clip loops). We never keep a sample taken at or past the
        // end: in "Play all" mode the viewer may already have switched clips there.
        let finished = false;
        function finish(why) {
            if (finished) return;
            finished = true;
            if (!why && frames.length && frames[frames.length - 1].time < def.duration - 1e-4) {
                frames.push({ time: def.duration, meshes: frames[0].meshes });
            }
            if (why) warn(`clip ${def.name}: ${why}, frames=${frames.length}`);
            cb(frames);
        }
        function tick() {
            try { tickBody(); } catch (e) {
                err(`clip ${def.name} tick`, e.message);
                finish('error, truncated');
            }
        }
        function tickBody() {
            if (window.clipCancel) { finish('cancelled'); return; }
            const t = clockNow();
            if (t >= def.duration) { finish(null); return; }
            progSub(t / def.duration, i18n('pr_seconds', { t: t.toFixed(1), d: def.duration.toFixed(1) }));
            const act = activeClipUids(mgr);
            if (act.length !== 1 || act[0] !== def.uid) {
                // "Play all" advances to the next clip as this one ends, and the sim
                // clock restarts. If we already have (almost) the whole clip, that is
                // the normal end, not a problem.
                if (lastT >= def.duration - 0.1 || lastSeen >= def.duration - 0.1) {
                    log(`clip ${def.name}: viewer moved to the next clip at the end, frames=${frames.length}`);
                    finish(null);
                    return;
                }
                finish('active clip changed mid-recording at t=' + t.toFixed(3) +
                       ' (active=' + act.join(',') + '), truncated');
                return;
            }
            // Keep times strictly increasing (a paused/stuck clock repeats values).
            if (t > lastT && fpsDue(t, lastT)) {
                frames.push({ time: t, meshes: snapshotFrame().meshes });
                lastT = t;
            }
            // Safety net: sim clock stuck, so end by wall time instead of looping forever.
            if (performance.now() / 1000 - wall0 > def.duration + 3) {
                finish(`clock stalled at t=${t.toFixed(3)}`);
                return;
            }
            lastSeen = t;   // last clock value seen (kept or skipped by RECORD_FPS), for end-of-clip detection
            requestAnimationFrame(tick);
        }
        log(`clip clock: ${useSim ? 'manager simulation time' : 'wall clock'} (${def.name})`);
        requestAnimationFrame(tick);
    }

    function recordClip(mgr, def, cb) {
        selectClipItem(def.index, (ok) => {
            const act = activeClipUids(mgr);
            if (!ok || act.length !== 1 || act[0] !== def.uid) {
                warn(`clip switch failed: ${def.name} active=${act.join(',')}`);
                cb(null);
                return;
            }
            const inst = mgr._instanceAnimations[def.uid];
            const base = (inst && inst.start) || 0;
            // Real-time capture only: seek-based sampling while paused updates the
            // palette too sparsely on this viewer. Seek to the clip start, let it
            // settle, then record while the clip plays.
            try {
                if (!mgr._pause) mgr.togglePause();
                mgr.setSeekTime(base);
            } catch (e) { err(`clip seek ${def.name}`, e.message); cb(null); return; }
            waitFrames(CONFIG.CLIP_SETTLE_FRAMES, () => {
                try { recordClipRealtime(mgr, def, base, cb); } catch (e) { err(`clip record ${def.name}`, e.message); cb(null); }
            });
        });
    }

    // Selects the viewer's "Static Pose" item and stores a palette snapshot. Used as
    // the joint rest pose when CONFIG.REST_POSE_SOURCE === 'static'. cb() is always
    // called; on any problem the snapshot stays null and export falls back to clip 0.
    function captureStaticPose(mgr, cb) {
        window.staticPoseSnapshot = null;
        if (window.clipStaticIdx < 0) {
            warn('static pose: no clip-less list item found, snapshot skipped');
            cb();
            return;
        }
        selectClipItem(window.clipStaticIdx, (ok) => {
            const act = activeClipUids(mgr);
            if (!ok || act.length) {
                warn(`static pose: selecting the item failed or left clips active (${act.length})`);
                cb();
                return;
            }
            // The viewer may skip updates while paused with no clip; let it run briefly.
            if (mgr._pause) mgr.togglePause();
            waitFrames(6, () => {
                const snapA = snapshotFrame();
                waitFrames(3, () => {
                    let snapB = snapshotFrame(), moved = 0;
                    for (let m = 0; m < snapA.meshes.length; m++) {
                        const pa = snapA.meshes[m].palette, pb = snapB.meshes[m] && snapB.meshes[m].palette;
                        if (!pa || !pb) continue;
                        for (let i = 0; i < pa.length; i++) {
                            if (Math.abs(pa[i] - pb[i]) > 1e-5) { moved++; break; }
                        }
                    }
                    if (moved) warn(`static pose: ${moved} mesh palette(s) still changing; using the later snapshot`);
                    window.staticPoseSnapshot = snapB;
                    log(`static pose captured, meshes=${snapB.meshes.length}`);
                    cb();
                });
            });
        });
    }

    function setRecAllLabel(text) {
        const el = document.getElementById('recAllBtn');
        if (el) el.textContent = text;
    }

    function endRecordAll(mgr, wasPaused, origIdx) {
        function reset() {
            window.clipRecording = false;
            window.clipCancel = false;
            window.clipProgress = '';
            setRecAllLabel(i18n('btn_rec_all'));
            progDone(window.clipCancel ? i18n('pr_recording_cancelled') : i18nN('pr_recorded_clips', window.clips.length), !!window.clipCancel);
            log(`record-all finished, clips recorded: ${window.clips.length}`);
        }
        try {
            selectClipItem(origIdx, () => {
                try { if (mgr._pause !== wasPaused) mgr.togglePause(); }
                catch (e) { err('endRecordAll restore pause', e.message); }
                reset();
            });
        } catch (e) {
            err('endRecordAll', e.message);
            reset();   // never leave clipRecording stuck on true
        }
    }

    function recordAllClips() {
        if (window.animationRecording || window.clipRecording) {
            warn('already recording');
            return;
        }
        if (_exporting) { warn('export is running: wait for "export done" before recording'); return; }
        const mgr = findAnimationManager();
        if (!mgr) { warn('no animation manager found; use RECORD SINGLE CLIP'); return; }
        window.clipRecording = true;
        window.clips = [];
        window.recordedFrames = [];   // a stale single recording must not win over the new clips
        window.clipCancel = false;
        setRecAllLabel(i18n('btn_cancel'));
        const wasPaused = mgr._pause;
        log('record-all started, clips in manager: ' + getClipCount() +
            ', fps ' + (+CONFIG.RECORD_FPS > 0 ? CONFIG.RECORD_FPS : 'every frame') + ' (keep this tab visible: a hidden tab pauses rendering and frames are skipped)');
        let safeOrigIdx = 0;
        try {
        discoverAnimationClips((defs, origIdx) => {
            safeOrigIdx = origIdx;
            if (defs.length < 2) {
                warn(`only ${defs.length} usable clip(s); single-clip path stays in use`);
                endRecordAll(mgr, wasPaused, origIdx);
                return;
            }
            let i = 0;
            function nextClip() {
                if (i >= defs.length || window.clipCancel) {
                    if (window.clipCancel) warn(`record-all cancelled, keeping ${window.clips.length} recorded clip(s)`);
                    endRecordAll(mgr, wasPaused, origIdx);
                    return;
                }
                const d = defs[i++];
                window.clipProgress = `${i}/${defs.length}`;
                progStage(i, defs.length, i18n('pr_recording', { name: d.name }));
                try {
                recordClip(mgr, d, (frames) => {
                    if (window.clipCancel) {
                        warn(`clip discarded (cancelled): ${d.name}`);
                    } else if (frames && frames.length > 1) {
                        window.clips.push({ name: d.name, uid: d.uid, frames });
                        log(`clip recorded: ${d.name} frames=${frames.length}`);
                    } else {
                        warn(`clip skipped: ${d.name}`);
                    }
                    nextClip();
                });
                } catch (e) {
                    err(`record-all clip ${d.name}`, e.message);
                    endRecordAll(mgr, wasPaused, origIdx);
                }
            }
            captureStaticPose(mgr, () => { nextClip(); });
        });
        } catch (e) {
            err('record-all', e.message);
            endRecordAll(mgr, wasPaused, safeOrigIdx);
        }
    }

    // ====================================================================
    // UI panel
    // ====================================================================
    // A hidden tab stops requestAnimationFrame: the viewer stops rendering and recording skips frames.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && (window.animationRecording || window.clipRecording)) {
            warn('tab hidden during recording: rendering pauses, frames will be skipped or the clip may be truncated; keep the tab visible');
        }
    });

    // Builds the panel again (after a language change), at the same place.
    let _panelTimers = [];
    function rebuildPanel(keepOpen) {
        const old = document.getElementById('ripper-panel');
        const pos = old ? { left: old.style.left, top: old.style.top, right: old.style.right } : null;
        _panelTimers.forEach(clearInterval); _panelTimers = [];
        if (old) old.remove();
        button_dw = false;
        addbtnfunc(true, keepOpen, pos);
    }

    function addbtnfunc(rebuilt, keepOpen, keepPos) {
        if (button_dw) return;
        if (!document.body) { setTimeout(addbtnfunc, 500); return; }
        if (document.getElementById('ripper-panel')) { button_dw = true; return; }

        if (!document.getElementById('ripper-style')) {
            const css = document.createElement('style');
            css.id = 'ripper-style';
            css.textContent = [
                '#ripper-panel{position:fixed;top:70px;right:16px;z-index:2147483647;width:212px;box-sizing:border-box;background:rgba(24,25,28,.94);',
                'backdrop-filter:blur(6px);border:1px solid #3a3d42;border-radius:12px;padding:10px;font:12px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;',
                'color:#e8eaed;display:flex;flex-direction:column;gap:7px;box-shadow:0 8px 28px rgba(0,0,0,.55)}',
                '#ripper-panel .rp-head{display:flex;align-items:center;gap:6px;padding-bottom:6px;border-bottom:1px solid #3a3d42}',
                '#ripper-panel .rp-title{flex:1;font-weight:700;letter-spacing:.06em;font-size:11px;color:#ff9f43;cursor:move;user-select:none}',
                '#ripper-panel .rp-gear{cursor:pointer;color:#9aa0a6;font-size:15px;line-height:1;padding:2px 4px;border-radius:6px;user-select:none}',
                '#ripper-panel .rp-gear:hover{background:#2f3236;color:#fff}',
                '#ripper-panel .rp-sec{font-size:10px;font-weight:600;letter-spacing:.08em;color:#9aa0a6;text-transform:uppercase;margin-top:2px}',
                '#ripper-panel .rp-row{display:flex;gap:6px}',
                '#ripper-panel .rp-btn{flex:1;padding:8px 6px;border:0;border-radius:8px;color:#fff;font:600 11px system-ui,sans-serif;letter-spacing:.03em;cursor:pointer;',
                'transition:background-color .15s,opacity .15s,transform .05s}',
                '#ripper-panel .rp-btn:active{transform:translateY(1px)}',
                '#ripper-panel .rp-dl{background:#1a73e8}#ripper-panel .rp-dl:hover{background:#1765cc}',
                '#ripper-panel .rp-rec{background:#c5221f}#ripper-panel .rp-rec:hover{background:#a50e0e}',
                '#ripper-panel .rp-rec.rp-on{background:#f28b82;color:#3c0a08}',
                '#ripper-panel .rp-btn:disabled{background:#3c4043;color:#80868b;cursor:not-allowed;transform:none}',
                '#ripper-progress{display:none;flex-direction:column;gap:4px;padding:6px 0 2px}',
                '#ripper-progress .rp-lab{display:flex;justify-content:space-between;gap:6px;font-size:10px;color:#bdc1c6;overflow-wrap:anywhere}',
                '#ripper-progress .rp-bar{height:6px;border-radius:3px;background:#3c4043;overflow:hidden}',
                '#ripper-progress .rp-bar.rp-thin{height:4px}',
                '#ripper-progress .rp-fill{height:100%;width:0;border-radius:3px;background:#8ab4f8;transition:width .2s}',
                '#ripper-progress .rp-thin .rp-fill{background:#5f9cf0}',
                '#ripper-progress .rp-fill.rp-busy{background:repeating-linear-gradient(45deg,#5f9cf0 0 8px,#3c6fc2 8px 16px);background-size:22px 22px;animation:rp-stripe .7s linear infinite}',
                '@keyframes rp-stripe{to{background-position:22px 0}}',
                '#ripper-progress.rp-err .rp-fill{background:#f28b82}',
                '#ripper-status{font-size:10px;color:#9aa0a6;text-align:center}',
                '#ripper-panel.rp-wide{width:270px}',
                '#ripper-config>div>span{flex:1;min-width:0}',
                '#ripper-config select{max-width:55%}',
                '#ripper-config input,#ripper-config select{background:#202124;color:#e8eaed;border:1px solid #5f6368;border-radius:5px;padding:2px 4px;font:11px system-ui,sans-serif}',
            ].join('');
            document.head.appendChild(css);
        }

        const panel = document.createElement('div');
        panel.id = 'ripper-panel';

        const titleRow = document.createElement('div');
        titleRow.className = 'rp-head';

        const title = document.createElement('div');
        title.textContent = 'MODEL RIPPER';   // i18n-ok (name of the script)
        title.className = 'rp-title';
        titleRow.appendChild(title);

        const gear = document.createElement('span');
        gear.textContent = '⚙';
        gear.title = i18n('settings');
        gear.className = 'rp-gear';
        titleRow.appendChild(gear);

        panel.appendChild(titleRow);

        function section(text) {
            const d = document.createElement('div');
            d.className = 'rp-sec'; d.textContent = text;
            panel.appendChild(d);
        }
        function button(id, text, cls, onClick) {
            const b = document.createElement('button');
            if (id) b.id = id;
            b.type = 'button';
            b.className = `rp-btn ${cls}`;
            b.textContent = text;
            b.addEventListener('click', onClick);
            return b;
        }

        section(i18n('sec_download'));
        const dlRow = document.createElement('div');
        dlRow.className = 'rp-row';
        const btnDL = button('dlGlbBtn', i18n('btn_glb'), 'rp-dl', () => { downloadGLB('glb'); });
        btnDL.title = i18n('tip_glb');
        const btnFBX = button('dlFbxBtn', i18n('btn_fbx'), 'rp-dl', () => { downloadGLB('fbx'); });
        btnFBX.title = i18n('tip_fbx');
        dlRow.appendChild(btnDL);
        dlRow.appendChild(btnFBX);
        panel.appendChild(dlRow);

        section(i18n('sec_animation'));
        const btnRec = button('recBtnLabel', window.animationRecording ? i18n('btn_stop') : i18n('btn_rec_single'), 'rp-rec', () => {
            if (!window.animationRecording) startRecording(); else stopRecording();
        });
        panel.appendChild(btnRec);

        const btnAll = button('recAllBtn', window.clipRecording ? i18n('btn_cancel') : i18n('btn_rec_all'), 'rp-rec', () => {
            if (window.clipRecording) {
                window.clipCancel = true;
                setRecAllLabel(i18n('btn_cancelling'));
                log('record-all: cancel requested');
                return;
            }
            recordAllClips();
        });
        panel.appendChild(btnAll);

        const progBox = document.createElement('div');
        progBox.id = 'ripper-progress';
        progBox.innerHTML = '<div class="rp-lab"><span id="rp-stage-label"></span></div>'
            + '<div class="rp-bar"><div class="rp-fill" id="rp-stage-fill"></div></div>'
            + '<div class="rp-bar rp-thin"><div class="rp-fill" id="rp-sub-fill"></div></div>'
            + '<div class="rp-lab"><span id="rp-sub-label"></span></div>';
        panel.appendChild(progBox);

        // Buttons that can't do anything right now are greyed out:
        // RECORD SINGLE CLIP needs 1+ clips, RECORD ALL CLIPS needs 2+, downloads wait for recordings.
        function setOff(b, off, why) {
            b.disabled = off;
            b.title = off ? why : (b.dataset.tip || '');
        }
        btnDL.dataset.tip = btnDL.title; btnFBX.dataset.tip = btnFBX.title;
        function refreshAllBtn() {
            let n = 0;
            try { n = getClipCount(); } catch (e) {}
            const recBusy = window.animationRecording || window.clipRecording;
            btnRec.classList.toggle('rp-on', !!window.animationRecording);
            btnAll.classList.toggle('rp-on', !!window.clipRecording);
            if (!window.animationRecording) setOff(btnRec, n < 1 || !!window.clipRecording || _exporting, n < 1 ? i18n('tip_no_clips') : i18n('tip_busy'));
            if (!window.clipRecording) setOff(btnAll, n < 2 || !!window.animationRecording || _exporting, n === 1 ? i18n('tip_one_clip') : n < 1 ? i18n('tip_no_clips') : i18n('tip_busy'));
            setOff(btnDL, recBusy || _exporting, i18n('tip_busy_dl'));
            setOff(btnFBX, recBusy || _exporting, i18n('tip_busy_dl'));
        }
        refreshAllBtn();
        _panelTimers.push(setInterval(refreshAllBtn, 500));

        const status = document.createElement('div');
        status.id = 'ripper-status';
        status.textContent = i18n('st_idle');
        panel.appendChild(status);

        // ---- config form (hidden until gear clicked) ----
        const configDiv = document.createElement('div');
        configDiv.id = 'ripper-config';
        configDiv.style.cssText = 'display:none;flex-direction:column;gap:5px;padding-top:6px;border-top:1px solid #3a3d42;font-size:11px;';

        const rowL = document.createElement('div');
        rowL.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const labelL = document.createElement('span');
        labelL.textContent = i18n('set_language');
        labelL.title = i18n('set_language_tip');
        rowL.appendChild(labelL);
        const selL = document.createElement('select');
        selL.style.cssText = 'background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        [['auto', i18n('opt_auto')]].concat(Object.keys(STRINGS).map((k) => [k, LANG_NAMES[k] || k])).forEach((o) => {
            const op = document.createElement('option');
            op.value = o[0]; op.textContent = o[1];
            if ((CONFIG.LANGUAGE || 'auto') === o[0]) op.selected = true;
            selL.appendChild(op);
        });
        selL.addEventListener('change', () => {
            CONFIG.LANGUAGE = selL.value;
            saveConfig();
            log(`language set to ${selL.value} (${uiLang()})`);
            rebuildPanel(true);
        });
        rowL.appendChild(selL);
        configDiv.appendChild(rowL);

        const row1 = document.createElement('div');
        row1.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label1 = document.createElement('span');
        label1.textContent = i18n('set_max_seconds');
        label1.title = i18n('set_max_seconds_tip');
        row1.appendChild(label1);
        const input1 = document.createElement('input');
        input1.type = 'number';
        input1.min = '1';
        input1.max = '60';
        input1.value = CONFIG.MAX_RECORD_SECONDS;
        input1.style.cssText = 'width:52px;background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        input1.addEventListener('change', () => {
            let v = parseInt(input1.value, 10);
            if (isNaN(v) || v < 1) v = 1;
            if (v > 60) v = 60;
            input1.value = v;
            CONFIG.MAX_RECORD_SECONDS = v;
            saveConfig();
        });
        row1.appendChild(input1);
        configDiv.appendChild(row1);

        const rowF = document.createElement('div');
        rowF.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const labelF = document.createElement('span');
        labelF.textContent = i18n('set_fps');
        labelF.title = i18n('set_fps_tip');
        rowF.appendChild(labelF);
        const selF = document.createElement('select');
        selF.style.cssText = 'background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        [[0, i18n('opt_fps_max')], [60, '60'], [30, '30'], [24, '24'], [15, '15']].forEach((o) => {
            const op = document.createElement('option');
            op.value = String(o[0]); op.textContent = o[1];
            if ((+CONFIG.RECORD_FPS || 0) === o[0]) op.selected = true;
            selF.appendChild(op);
        });
        selF.addEventListener('change', () => {
            CONFIG.RECORD_FPS = parseInt(selF.value, 10) || 0;
            saveConfig();
            log(`record fps set to ${CONFIG.RECORD_FPS || 'every frame'}`);
        });
        rowF.appendChild(selF);
        configDiv.appendChild(rowF);

        const row2 = document.createElement('div');
        row2.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label2 = document.createElement('span');
        label2.textContent = i18n('set_reload');
        label2.title = i18n('set_reload_tip');
        row2.appendChild(label2);
        const check2 = document.createElement('input');
        check2.type = 'checkbox';
        check2.checked = CONFIG.AUTO_RELOAD_ON_FAILURE;
        check2.addEventListener('change', () => {
            CONFIG.AUTO_RELOAD_ON_FAILURE = check2.checked;
            saveConfig();
        });
        row2.appendChild(check2);
        configDiv.appendChild(row2);

        const row5 = document.createElement('div');
        row5.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label5 = document.createElement('span');
        label5.textContent = i18n('set_double');
        label5.title = i18n('set_double_tip');
        row5.appendChild(label5);
        const check5 = document.createElement('input');
        check5.type = 'checkbox';
        check5.checked = !!CONFIG.DOUBLE_SIDED;
        check5.addEventListener('change', () => {
            CONFIG.DOUBLE_SIDED = check5.checked;
            saveConfig();
            log(`double sided set to ${check5.checked}`);
        });
        row5.appendChild(check5);
        configDiv.appendChild(row5);

        const row5b = document.createElement('div');
        row5b.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label5b = document.createElement('span');
        label5b.textContent = i18n('set_single_auto');
        label5b.title = i18n('set_single_auto_tip');
        row5b.appendChild(label5b);
        const check5b = document.createElement('input');
        check5b.type = 'checkbox';
        check5b.checked = !!CONFIG.DOUBLE_SIDED_AUTO;
        check5b.addEventListener('change', () => {
            CONFIG.DOUBLE_SIDED_AUTO = check5b.checked;
            saveConfig();
            log(`auto single sided set to ${check5b.checked}`);
        });
        row5b.appendChild(check5b);
        configDiv.appendChild(row5b);

        const row5c = document.createElement('div');
        row5c.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label5c = document.createElement('span');
        label5c.textContent = i18n('set_slivers');
        label5c.title = i18n('set_slivers_tip');
        row5c.appendChild(label5c);
        const check5c = document.createElement('input');
        check5c.type = 'checkbox';
        check5c.checked = !!CONFIG.DROP_STRIP_SLIVERS;
        check5c.addEventListener('change', () => {
            CONFIG.DROP_STRIP_SLIVERS = check5c.checked;
            saveConfig();
            log(`drop strip slivers set to ${check5c.checked}`);
        });
        row5c.appendChild(check5c);
        configDiv.appendChild(row5c);

        const row5d = document.createElement('div');
        row5d.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label5d = document.createElement('span');
        label5d.textContent = i18n('set_reduce');
        label5d.title = i18n('set_reduce_tip');
        row5d.appendChild(label5d);
        const check5d = document.createElement('input');
        check5d.type = 'checkbox';
        check5d.checked = !!CONFIG.REDUCE_KEYS;
        check5d.addEventListener('change', () => {
            CONFIG.REDUCE_KEYS = check5d.checked;
            saveConfig();
            log(`reduce keyframes set to ${check5d.checked}`);
        });
        row5d.appendChild(check5d);
        configDiv.appendChild(row5d);

        const row5e = document.createElement('div');
        row5e.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label5e = document.createElement('span');
        label5e.textContent = i18n('set_still');
        label5e.title = i18n('set_still_tip');
        row5e.appendChild(label5e);
        const check5e = document.createElement('input');
        check5e.type = 'checkbox';
        check5e.checked = !!CONFIG.KEEP_STILL_CLIPS;
        check5e.addEventListener('change', () => {
            CONFIG.KEEP_STILL_CLIPS = check5e.checked;
            saveConfig();
            log(`keep still clips set to ${check5e.checked}`);
        });
        row5e.appendChild(check5e);
        configDiv.appendChild(row5e);

        const row6 = document.createElement('div');
        row6.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label6 = document.createElement('span');
        label6.textContent = i18n('set_vcolor');
        label6.title = i18n('set_vcolor_tip');
        row6.appendChild(label6);
        const check6 = document.createElement('input');
        check6.type = 'checkbox';
        check6.checked = !!CONFIG.VERTEX_COLOR_SRGB;
        check6.addEventListener('change', () => {
            CONFIG.VERTEX_COLOR_SRGB = check6.checked;
            saveConfig();
            log(`vertex color sRGB->linear set to ${check6.checked}`);
        });
        row6.appendChild(check6);
        configDiv.appendChild(row6);

        const row7 = document.createElement('div');
        row7.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label7 = document.createElement('span');
        label7.textContent = i18n('set_flat_mr');
        label7.title = i18n('set_flat_mr_tip');
        row7.appendChild(label7);
        const check7 = document.createElement('input');
        check7.type = 'checkbox';
        check7.checked = !!CONFIG.FLAT_MR_FROM_VIEWER;
        check7.addEventListener('change', () => {
            CONFIG.FLAT_MR_FROM_VIEWER = check7.checked;
            saveConfig();
            log(`flat metal/rough from viewer set to ${check7.checked}`);
        });
        row7.appendChild(check7);
        configDiv.appendChild(row7);

        const row8 = document.createElement('div');
        row8.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label8 = document.createElement('span');
        label8.textContent = i18n('set_scale');
        label8.title = i18n('set_scale_tip');
        row8.appendChild(label8);
        const input8 = document.createElement('input');
        // text, not type=number: a number field rejects "0,01" in some browsers and languages
        input8.type = 'text';
        input8.inputMode = 'decimal';
        const decSep = (1.5).toLocaleString(uiLang()).charAt(1) === ',' ? ',' : '.';   // show 0,01 in languages that write a comma
        const showNum = (v) => String(v).replace('.', decSep);
        input8.value = showNum(CONFIG.EXPORT_SCALE);
        input8.style.cssText = 'width:64px;background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        input8.addEventListener('change', () => {
            let v = parseFloat(String(input8.value).trim().replace(',', '.'));
            if (isNaN(v) || v <= 0) v = 1;
            input8.value = showNum(v);
            CONFIG.EXPORT_SCALE = v;
            saveConfig();
            log(`export scale set to ${v}`);
        });
        row8.appendChild(input8);
        configDiv.appendChild(row8);

        const row3 = document.createElement('div');
        row3.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label3 = document.createElement('span');
        label3.textContent = i18n('set_mr_format');
        label3.title = i18n('set_mr_format_tip');
        row3.appendChild(label3);
        const sel3 = document.createElement('select');
        sel3.style.cssText = 'background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        [['jpeg', i18n('opt_jpeg')], ['png', i18n('opt_png')]].forEach((opt) => {
            const o = document.createElement('option');
            o.value = opt[0];
            o.textContent = opt[1];
            if (CONFIG.MR_TEXTURE_FORMAT === opt[0]) o.selected = true;
            sel3.appendChild(o);
        });
        sel3.addEventListener('change', () => {
            CONFIG.MR_TEXTURE_FORMAT = sel3.value;
            saveConfig();
        });
        row3.appendChild(sel3);
        configDiv.appendChild(row3);

        const row4 = document.createElement('div');
        row4.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label4 = document.createElement('span');
        label4.textContent = i18n('set_rest');
        label4.title = i18n('set_rest_tip');
        row4.appendChild(label4);
        const sel4 = document.createElement('select');
        sel4.style.cssText = 'background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        [['clip0', i18n('opt_clip0')], ['static', i18n('opt_static')]].forEach((opt) => {
            const o = document.createElement('option');
            o.value = opt[0];
            o.textContent = opt[1];
            if (CONFIG.REST_POSE_SOURCE === opt[0]) o.selected = true;
            sel4.appendChild(o);
        });
        sel4.addEventListener('change', () => {
            CONFIG.REST_POSE_SOURCE = sel4.value;
            saveConfig();
            log(`rest pose source set to ${sel4.value}`);
        });
        row4.appendChild(sel4);
        configDiv.appendChild(row4);

        panel.appendChild(configDiv);

        // The settings need more room (longer labels in some languages): the panel gets wider while they are open.
        gear.addEventListener('click', () => {
            const open = configDiv.style.display === 'none';
            configDiv.style.display = open ? 'flex' : 'none';
            panel.classList.toggle('rp-wide', open);
        });
        if (keepOpen) { configDiv.style.display = 'flex'; panel.classList.add('rp-wide'); }
        if (keepPos) { panel.style.left = keepPos.left; panel.style.top = keepPos.top; panel.style.right = keepPos.right; }

        document.body.appendChild(panel);
        button_dw = true;
        log(`panel added (language ${uiLang()})`);
        if (rebuilt) return;   // the checks below run once per page

        // Warn if the bad bundle was served. After 8s, show hint. After
        // 12s, auto-reload once (guarded by sessionStorage so we don't loop).
        setTimeout(() => {
            if (window._anyAnchorsMatched) return;
            const s = document.getElementById('ripper-status');
            if (s) {
                s.textContent = i18n('st_no_anchors');
                s.style.color = '#f80';
            }
            log('no anchors matched after 8s; bundle is the incompatible build');
        }, 8000);

        setTimeout(() => {
            if (window._anyAnchorsMatched) return;
            let already;
            try { already = sessionStorage.getItem('ripper_reloaded'); } catch (e) { already = '1'; }
            if (already) return;
            if (!CONFIG.AUTO_RELOAD_ON_FAILURE) return;
            try { sessionStorage.setItem('ripper_reloaded', '1'); if (sessionStorage.getItem('ripper_reloaded') !== '1') return; } catch (e) { return; }
            log('no anchors after 12s, auto-reloading once');
            location.reload();
        }, 12000);

        setInterval(() => {
            const s = document.getElementById('ripper-status');
            if (!s) return;
            if (!window._anyAnchorsMatched && s.textContent === i18n('st_no_anchors')) return;
            const busy = window.animationRecording || window.clipRecording;
            const state = window.animationRecording ? i18n('st_rec') : (window.clipRecording ? i18n('st_clips', { p: window.clipProgress }) : i18n('st_idle'));
            s.textContent = i18n('st_line', { state, m: window.allmodel.length, f: window.recordedFrames.length, c: getClipCount() })
                          + (window.clips.length ? i18n('st_rec_clips', { n: window.clips.length }) : '');
            s.style.color = busy ? '#f28b82' : '#9aa0a6';
        }, 500);

        ((el, handle) => {
            let ox = 0, oy = 0, drag = false;
            handle.addEventListener('mousedown', (e) => {
                drag = true; ox = e.clientX - el.offsetLeft; oy = e.clientY - el.offsetTop; e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
                if (!drag) return;
                el.style.left = `${e.clientX - ox}px`;
                el.style.top  = `${e.clientY - oy}px`;
                el.style.right = 'auto';
            });
            document.addEventListener('mouseup', () => { drag = false; });
        })(panel, title);
    }

    // ====================================================================
    // parseobj
    // ====================================================================
    function parseobj(obj) {
        const list = [];
        (obj._primitives || []).forEach((p) => {
            if (p && p.indices) list.push({ mode: p.mode, indices: p.indices._elements });
        });
        const attr = obj._attributes || {};
        let joints  = attr.Joints0  || attr.JOINTS_0 || attr.joints0 || attr.Joints  || attr.JOINTS  || attr.Bones || attr.BONES;
        let weights = attr.Weights0 || attr.WEIGHTS_0 || attr.weights0 || attr.Weights || attr.WEIGHTS || attr.BoneWeights || attr.BONEWEIGHTS;
        if (joints)  joints  = joints._elements;
        if (weights) weights = weights._elements;
        // Sketchfab assigns arbitrary TexCoordN indices per mesh
        // (e.g. TexCoord0, TexCoord3, TexCoord6 on the same model),
        // so scan for any TexCoordN key rather than hard-coding.
        let uvAttr = null;
        let _uvBestNum = Infinity;
        for (let _k in attr) {
            if (!attr.hasOwnProperty(_k)) continue;
            const _m = /^TexCoord(\d+)$/.exec(_k);
            if (!_m) continue;
            const _a = attr[_k];
            if (!_a || !_a._elements || !_a._elements.length) continue;
            const _n = parseInt(_m[1], 10);
            if (_n < _uvBestNum) {
                _uvBestNum = _n;
                uvAttr = _a;
            }
        }

        return {
            vertex: attr.Vertex ? attr.Vertex._elements : [],
            normal: attr.Normal ? attr.Normal._elements : [],
            uv: uvAttr ? uvAttr._elements : [],
            color: (attr.Color && attr.Color._elements) ? attr.Color._elements : [],
            joints,
            weights,
            primitives: list
        };
    }

    // ====================================================================
    // MetallicRoughness merge
    // ====================================================================
    // glTF wants metalness in B, roughness in G of one texture. Sketchfab
    // ships them as separate grayscale images (MetalnessPBR, RoughnessPBR,
    // or GlossinessPBR). Merge per mesh into one <mesh>_MR.png.
    function _blobForSanitizedName(sanitized) {
        for (let key in saveimagecache2) {
            if (!saveimagecache2.hasOwnProperty(key)) continue;
            const t = saveimagecache2[key];
            if (!t || !t.dataURL) continue;
            if (sanitizeTextureName(t.name) === sanitized) {
                const ext = t.fileExt || '.png';
                const fname = t.name + ext;
                if (objects[fname]) return objects[fname];
            }
        }
        return null;
    }

    function _mergeOneMR(cm, forcePng) {
        const metalSan = cm.MetalnessPBR && cm.MetalnessPBR.name
                     ? sanitizeTextureName(cm.MetalnessPBR.name) : null;
        const roughSan = cm.RoughnessPBR && cm.RoughnessPBR.name
                     ? sanitizeTextureName(cm.RoughnessPBR.name) : null;
        const glossSan = cm.GlossinessPBR && cm.GlossinessPBR.name
                     ? sanitizeTextureName(cm.GlossinessPBR.name) : null;

        const metalBlob = metalSan ? _blobForSanitizedName(metalSan) : null;
        const roughBlob = roughSan ? _blobForSanitizedName(roughSan) : null;
        const glossBlob = glossSan ? _blobForSanitizedName(glossSan) : null;

        if (!metalBlob && !roughBlob && !glossBlob) return Promise.resolve(null);

        const pending = [];
        if (metalBlob) pending.push(createImageBitmap(metalBlob));
        if (roughBlob) pending.push(createImageBitmap(roughBlob));
        if (glossBlob) pending.push(createImageBitmap(glossBlob));

        return Promise.all(pending).then((bmps) => {
            let i = 0;
            const mBmp = metalBlob ? bmps[i++] : null;
            const rBmp = roughBlob ? bmps[i++] : null;
            const gBmp = glossBlob ? bmps[i++] : null;
            const ref = mBmp || rBmp || gBmp;
            const W = ref.width, H = ref.height;

            function readGray(bmp) {
                const c = document.createElement('canvas');
                c.width = W; c.height = H;
                const x = c.getContext('2d');
                x.drawImage(bmp, 0, 0, W, H);
                const px = x.getImageData(0, 0, W, H).data;
                c.width = 0; if (bmp.close) bmp.close();   // release the bitmap and canvas memory early
                return px;
            }
            const mData = mBmp ? readGray(mBmp) : null;
            const rData = rBmp ? readGray(rBmp) : null;
            const gData = gBmp ? readGray(gBmp) : null;

            const out = new Uint8ClampedArray(W * H * 4);
            for (let p = 0; p < W * H; p++) {
                const metal = mData ? mData[p * 4] : 255;   // no metal map: 255, the metallicFactor carries the flat value
                let rough;
                if (rData) rough = rData[p * 4];
                else if (gData) rough = 255 - gData[p * 4];
                else rough = 255;
                out[p * 4 + 0] = 255;
                out[p * 4 + 1] = rough;
                out[p * 4 + 2] = metal;
                out[p * 4 + 3] = 255;
            }

            const oc = document.createElement('canvas');
            oc.width = W; oc.height = H;
            oc.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
            const useJpeg = !forcePng && CONFIG.MR_TEXTURE_FORMAT !== 'png';
            const mime = useJpeg ? 'image/jpeg' : 'image/png';
            const ext  = useJpeg ? '.jpg' : '.png';
            const q    = useJpeg ? 0.92 : undefined;
            return new Promise((res) => {
                oc.toBlob((b) => { res({ blob: b, ext, hasM: !!mBmp, hasR: !!(rBmp || gBmp) }); }, mime, q);
            });
        });
    }

    // onJob(done, total) after each merged material; forcePng: lossless (FBX splits the image again)
    function mergeMRTextures(onJob, forcePng) {
        const jobs = [];
        let done = 0;
        const tick = () => { done++; if (onJob) onJob(done, jobs.length); };
        const seen = {};
        window.allmodel.forEach((obj, i) => {
            const ss = obj.stateset;
            const meshName = obj._name
                         || (ss && ss._name)
                         || (`mesh_${i}`);
            const cm = getChannelTextureMap(obj);
            if (!cm.MetalnessPBR && !cm.RoughnessPBR && !cm.GlossinessPBR) return;
            const san = sanitizeTextureName(meshName);
            if (seen[san]) return;
            seen[san] = true;
            jobs.push(
                _mergeOneMR(cm, forcePng).then((result) => {
                    if (!result || !result.blob) return;
                    const fname = `${san}_MR${result.ext}`;
                    objects[fname] = result.blob;
                    saveimagecache2[`__merged_mr__:${san}`] = {
                        name: `${san}_MR`,
                        fileExt: result.ext,
                        dataURL: 'merged',
                        hasM: result.hasM,
                        hasR: result.hasR
                    };
                    log('merged MR:', meshName, '→', fname, `${result.blob.size}B`);
                }).catch((e) => {
                    warn('MR merge failed for', meshName, e.message);
                }).then(tick)
            );
        });
        if (onJob) onJob(0, jobs.length);
        return jobs.length ? Promise.all(jobs) : Promise.resolve();
    }

    // ====================================================================
    // Opacity merge
    // ====================================================================
    // Sketchfab ships transparency as a separate grayscale Opacity image
    // (black = see-through, white = opaque; often a JPEG, so we use its
    // luminance, not a real alpha channel). glTF wants it in the alpha of the
    // base color texture. Merge per mesh into <mesh>_Alpha.png and mark the
    // material BLEND. The color and mask can share one metadata name (both
    // "HEMTT_Glass_BaseColor" on the Patriot), so sources are matched by URL.
    function _urlTail(u) {
        const parts = normalizeUrl(u).split('/');
        const last = parts[parts.length - 1] || '';
        return last.replace(/\.[A-Za-z0-9]+$/, '');
    }

    function _blobForUrl(url) {
        let want = normalizeUrl(url), wantTail = _urlTail(url), hit = null, key, t;
        // Exact URL first, then the file hash (Sketchfab serves size variants of
        // the same file under different paths).
        for (key in saveimagecache2) {
            if (!saveimagecache2.hasOwnProperty(key)) continue;
            t = saveimagecache2[key];
            if (t && t.dataURL && want && normalizeUrl(key) === want) { hit = t; break; }
        }
        if (!hit && wantTail) {
            for (key in saveimagecache2) {
                if (!saveimagecache2.hasOwnProperty(key)) continue;
                t = saveimagecache2[key];
                if (t && t.dataURL && _urlTail(key) === wantTail) { hit = t; break; }
            }
        }
        if (!hit) return null;
        return objects[hit.name + (hit.fileExt || '.png')] || null;
    }

    // Opacity comes either from the Opacity channel (blend) or the AlphaMask channel (cutout).
    function opacitySource(cm) {
        function real(c) { return c && (c.url || c.name) && !c.atlas; }
        return real(cm.Opacity) ? cm.Opacity : (real(cm.AlphaMask) ? cm.AlphaMask : (cm.Opacity || cm.AlphaMask || null));
    }

    function _mergeOneOpacity(cm) {
        const noColor = !cm.AlbedoPBR || !(cm.AlbedoPBR.url || cm.AlbedoPBR.name) || cm.AlbedoPBR.atlas;
        const colorBlob = noColor ? null : _blobForUrl(cm.AlbedoPBR.url);
        const maskBlob = _blobForUrl(opacitySource(cm).url);
        if ((!noColor && !colorBlob) || !maskBlob) {
            warn(`opacity merge: missing source (color=${!!colorBlob} mask=${!!maskBlob})`);
            return Promise.resolve(null);
        }
        return Promise.all([noColor ? null : createImageBitmap(colorBlob), createImageBitmap(maskBlob)]).then((bmps) => {
            const mBmp = bmps[1], cBmp = bmps[0] || mBmp;
            const W = cBmp.width, H = cBmp.height;
            function readPixels(bmp) {
                const c = document.createElement('canvas');
                c.width = W; c.height = H;
                const x = c.getContext('2d');
                x.drawImage(bmp, 0, 0, W, H);   // the mask is scaled to the color size
                const px = x.getImageData(0, 0, W, H).data;
                c.width = 0; if (bmp.close) bmp.close();   // release the bitmap and canvas memory early
                return px;
            }
            const cData = noColor ? null : readPixels(cBmp), mData = readPixels(mBmp);
            const out = new Uint8ClampedArray(W * H * 4);
            for (let p = 0; p < W * H; p++) {
                const q = p * 4;
                out[q] = cData ? cData[q] : 255;          // no colour image: white, the factor gives the colour
                out[q + 1] = cData ? cData[q + 1] : 255;
                out[q + 2] = cData ? cData[q + 2] : 255;
                // luminance of the mask: black = clear, white = solid
                out[q + 3] = Math.round(0.2126 * mData[q] + 0.7152 * mData[q + 1] + 0.0722 * mData[q + 2]);
            }
            const oc = document.createElement('canvas');
            oc.width = W; oc.height = H;
            oc.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
            return new Promise((res) => {
                oc.toBlob((b) => { res({ blob: b, ext: '.png' }); }, 'image/png');   // PNG: JPEG drops alpha
            });
        });
    }

    let _opacityKind = {};      // sanitized mesh name -> 'opacity' | 'alphamask'
    let _alphaFirst = {};       // 'colorUrl|maskUrl' -> first sanitized mesh name that merged it
    let _alphaShare = {};       // sanitized mesh name -> sanitized name that owns the merged texture
    let _opacityNoColor = {};   // sanitized mesh name -> merged opacity has no colour image (white RGB, alpha only)
    let _opacityOneFile = {};   // sanitized mesh name -> true when opacity lives in the base color file's alpha

    function mergeOpacityTextures(onJob) {
        let done = 0;
        const tick = () => { done++; if (onJob) onJob(done, jobs.length); };
        _opacityOneFile = {};
        _opacityKind = {};
        _alphaFirst = {};
        _alphaShare = {};
        _opacityNoColor = {};
        const jobs = [];
        const seen = {};
        window.allmodel.forEach((obj, i) => {
            const ss = obj.stateset;
            const meshName = obj._name || (ss && ss._name) || (`mesh_${i}`);
            const cm = getChannelTextureMap(obj);
            const opSrc = opacitySource(cm);
            if (!opSrc || !(opSrc.url || opSrc.name) || opSrc.atlas) return;
            const mch = getMaterialChannels(obj);
            const isOpacity = opSrc === cm.Opacity;
            const opCh = mch && (isOpacity ? mch.Opacity : mch.AlphaMask);
            if (opCh && opCh.enable === false) return;   // texture present but the channel is switched off in the viewer
            const san = sanitizeTextureName(meshName);
            if (seen[san]) return;
            seen[san] = true;
            // Opacity channel of a cutout type behaves like a mask (MASK), blend types use BLEND.
            const oType = String((opCh && opCh.type) || '');
            _opacityKind[san] = (isOpacity && !/mask|dither|cutout/i.test(oType)) ? 'opacity' : 'alphamask';
            if (!cm.AlbedoPBR || !(cm.AlbedoPBR.url || cm.AlbedoPBR.name) || cm.AlbedoPBR.atlas) {
                _opacityNoColor[san] = true;   // opacity image only: merge into a white RGB + alpha texture
            } else if (normalizeUrl(opSrc.url) === normalizeUrl(cm.AlbedoPBR.url)) {
                _opacityOneFile[san] = true;
                log(`opacity merge: ${meshName} uses one file for color and opacity, skipped`);
                return;
            }
            // Meshes sharing the same colour and mask images share one merged texture.
            const okey = `${_opacityNoColor[san] ? 'white' : normalizeUrl(cm.AlbedoPBR.url)}|${normalizeUrl(opSrc.url)}`;
            if (_alphaFirst[okey]) { _alphaShare[san] = _alphaFirst[okey]; log(`opacity merge: ${meshName} shares the merged texture of ${_alphaFirst[okey]}`); return; }
            _alphaFirst[okey] = san;
            jobs.push(
                _mergeOneOpacity(cm).then((result) => {
                    if (!result || !result.blob) return;
                    const fname = `${san}_Alpha${result.ext}`;
                    objects[fname] = result.blob;
                    saveimagecache2[`__merged_op__:${san}`] = {
                        name: `${san}_Alpha`,
                        fileExt: result.ext,
                        dataURL: 'merged'
                    };
                    log('merged opacity:', meshName, '→', fname, `${result.blob.size}B`);
                }).catch((e) => {
                    warn('opacity merge failed for', meshName, e.message);
                }).then(tick)
            );
        });
        if (onJob) onJob(0, jobs.length);
        return jobs.length ? Promise.all(jobs) : Promise.resolve();
    }

    // ====================================================================
    // Texture readiness
    // ====================================================================
    // Textures are only captured when the viewer draws them, which happens in a
    // burst while the model loads (and lags most). Exporting before that burst
    // ends produces a GLB with missing images. Count what the meshes reference
    // against what has been captured, and wait a little if some are missing.
    function textureReadiness() {
        let seen = {}, expected = 0, missing = 0;
        window.allmodel.forEach((obj) => {
            const cm = getChannelTextureMap(obj);
            for (let ch in cm) {
                if (!cm.hasOwnProperty(ch) || !cm[ch] || !cm[ch].url) continue;
                const id = _urlTail(cm[ch].url) || normalizeUrl(cm[ch].url);
                if (seen[id]) continue;
                seen[id] = true;
                expected++;
                if (!_blobForUrl(cm[ch].url)) missing++;
            }
        });
        return { expected, missing };
    }

    // onProg(captured, expected, secondsLeft)
    function waitForTextures(onProg) {
        const maxMs = (CONFIG.TEXTURE_WAIT_SECONDS || 0) * 1000;
        const first = textureReadiness();
        const report = (r, left) => { if (onProg) onProg(r.expected - r.missing, r.expected, left); };
        report(first, maxMs / 1000);
        if (maxMs <= 0 || first.missing === 0) return Promise.resolve();
        log('textures still loading: ' + (first.expected - first.missing) + '/' + first.expected +
            ' captured, waiting up to ' + CONFIG.TEXTURE_WAIT_SECONDS + 's (keep this tab visible)');
        return new Promise((resolve) => {
            let start = Date.now(), lastProgressAt = start, lastCaptured = first.expected - first.missing;
            (function poll() {
                setTimeout(() => {
                    const r = textureReadiness(), captured = r.expected - r.missing, now = Date.now();
                    report(r, Math.max(0, (maxMs - (now - start)) / 1000));
                    if (captured > lastCaptured) {
                        lastCaptured = captured;
                        lastProgressAt = now;
                        log(`textures captured: ${captured}/${r.expected}`);
                    }
                    if (r.missing === 0) { log(`all ${r.expected} textures captured`); resolve(); return; }
                    // Some textures are never drawn (tiny ones are skipped on purpose). Once
                    // some arrived and then nothing new came for 5 s, stop waiting.
                    if (captured > 0 && now - lastProgressAt > 5000) {
                        warn(`textures: ${r.missing}/${r.expected} never appeared, exporting without them`);
                        resolve();
                        return;
                    }
                    if (now - start >= maxMs) {
                        warn(`textures: timed out with ${r.missing}/${r.expected} missing, exporting without them`);
                        resolve();
                        return;
                    }
                    poll();
                }, 500);
            })();
        });
    }

    // ====================================================================
    // GLB Export
    // ====================================================================
    // format: 'glb' or 'fbx'. Both build the same glTF first; FBX is converted from it.
    function downloadGLB(format) {
        format = format === 'fbx' ? 'fbx' : 'glb';
        if (_exporting) { warn('export already running, ignored'); return; }
        if (window.animationRecording || window.clipRecording) { warn('recording is still running: press STOP first (export would miss the animation)'); return; }
        _exporting = true;
        log(`export started (${format.toUpperCase()})`);
        const stages = format === 'fbx'
            ? ['stage_textures', 'stage_merge', 'stage_build', 'stage_fbx', 'stage_split', 'stage_zip']
            : ['stage_textures', 'stage_merge', 'stage_build', 'stage_zip'];
        const stage = (k) => progStage(k + 1, stages.length, i18n(stages[k]));
        stage(0);
        waitForTextures((got, total, left) => {
            if (!total) progSub(1, i18n('pr_no_textures'));
            else if (got >= total) progSub(1, i18n('pr_all_captured', { n: total }));
            else progSub(got / total, i18n('pr_captured_wait', { got, total, s: Math.ceil(left) }));
        })
            .then(() => {
                stage(1);
                // two parts: metal/rough maps, then opacity into base colour alpha
                return mergeMRTextures((d, n) => progSub(n ? 0.5 * d / n : 0.5, n ? i18n('pr_mr', { d, n }) : i18n('pr_no_mr')), format === 'fbx');
            })
            .then(() => mergeOpacityTextures((d, n) => progSub(n ? 0.5 + 0.5 * d / n : 1, n ? i18n('pr_op', { d, n }) : i18n('pr_no_op'))))
            .then(() => { stage(2); progSub(-1, i18n('pr_building')); return nextPaint(); })
            .then(() => {
                const built = _downloadGLBSync();
                if (format === 'glb') return packZip(built, { [`${built.modelName}.glb`]: new Blob([built.glb], { type: 'application/octet-stream' }) }, stage, 3);
                return exportFBX(built, stage);
            })
            .then(() => { _exporting = false; progDone(i18n('pr_done')); })
            .catch((e) => {
                _exporting = false;
                progDone(i18n('pr_export_failed'), true);
                err('export failed:', e.message, e.stack);
            });
    }

    function nextPaint() { return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); }

    // Zips the model file(s) with the captured textures. extra: { path: Blob }.
    function packZip(built, files, stage, stageIdx) {
        stage(stageIdx);
        const zip = new JSZip();
        Object.keys(files).forEach((fp) => zip.file(fp, files[fp]));
        for (const tn in built.zipTex) {
            if (built.zipTex.hasOwnProperty(tn) && objects[tn]) {
                if (built.skipTex && built.skipTex[`textures/${built.zipTex[tn]}`]) continue;
                zip.file(`textures/${built.zipTex[tn]}`, objects[tn], { compression: 'STORE' });   // PNG/JPEG are already compressed
            }
        }
        (built.extraTex || []).forEach((t) => zip.file(t.path, t.blob, { compression: 'STORE' }));
        return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
            (meta) => progSub(meta.percent / 100, `${Math.round(meta.percent)}%`)).then((content) => {
            saveAs(content, `${built.modelName}.zip`);
            log('export done:', `${built.modelName}.zip`);
        }).catch((e) => { throw new Error('zip failed: ' + e.message); });
    }

    // zlib deflate for compressed FBX arrays (CompressionStream 'deflate' = zlib format)
    function zlibDeflate(u8) {
        if (typeof CompressionStream === 'undefined') return Promise.resolve(null);
        const cs = new CompressionStream('deflate');
        const out = new Response(cs.readable).arrayBuffer().then((b) => new Uint8Array(b));
        const w = cs.writable.getWriter(); w.write(u8); w.close();
        return out;
    }

    // One channel of an image as a grayscale PNG (FBX has no packed metal/rough map).
    function splitChannel(blob, channel) {
        return createImageBitmap(blob).then((bmp) => {
            const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
            const cx = c.getContext('2d'); cx.drawImage(bmp, 0, 0);
            const id = cx.getImageData(0, 0, c.width, c.height), d = id.data, k = { R: 0, G: 1, B: 2 }[channel];
            for (let i = 0; i < d.length; i += 4) { const v = d[i + k]; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
            cx.putImageData(id, 0, 0);
            return new Promise((res) => c.toBlob(res, 'image/png'));
        });
    }

    // FbxWriter reports English labels like "geometry 3/49": show them in the panel language.
    function fbxLabel(label) {
        const m = /^([a-z ]+?)(?: (\d+)\/(\d+))?$/.exec(label || '');
        if (!m) return label;
        const key = 'fbx_' + m[1].replace(/ /g, '_') + (m[2] ? '_n' : '');
        return (STRINGS.en[key] !== undefined) ? i18n(key, { i: m[2], n: m[3] }) : label;
    }

    function exportFBX(built, stage) {
        stage(3);
        const fps = +CONFIG.RECORD_FPS > 0 ? +CONFIG.RECORD_FPS : 30;
        return FbxWriter.gltfToFbx(built.gltf, built.bin, {
            creator: `Sketchfab Ripper ${typeof GM_info !== 'undefined' && GM_info.script ? GM_info.script.version : ''}`.trim(),
            fps: [24, 25, 30, 48, 50, 60].indexOf(fps) >= 0 ? fps : 30,
            deflate: zlibDeflate,
            onProgress: (f, label) => progSub(f, fbxLabel(label)),
        }).then((res) => {
            res.warnings.forEach((w) => warn('fbx: ' + w));
            const st = res.stats;
            log(`fbx written: ${(res.fbx.byteLength / 1048576).toFixed(1)} MB, models=${st.models} geometries=${st.geometries} materials=${st.materials} textures=${st.textures} clusters=${st.clusters} clips=${st.stacks} curves=${st.curves}`);
            stage(4);
            const byUri = {};
            for (const tn in built.zipTex) if (built.zipTex.hasOwnProperty(tn) && objects[tn]) byUri[`textures/${built.zipTex[tn]}`] = objects[tn];
            built.extraTex = [];
            built.skipTex = {};
            let n = 0;
            return res.splits.reduce((p, sp) => p.then(() => {
                progSub(n++ / Math.max(1, res.splits.length), sp.out.split('/').pop());
                const src = byUri[sp.src];
                if (!src) { warn(`fbx: no image for ${sp.src}, metal/rough map left out`); return null; }
                return splitChannel(src, sp.channel).then((b) => { if (b) { built.extraTex.push({ path: sp.out, blob: b }); built.skipTex[sp.src] = true; } })
                    .catch((e) => warn(`fbx: could not split ${sp.src}: ${e.message}`));
            }), Promise.resolve()).then(() => {
                if (res.splits.length) log(`fbx: ${built.extraTex.length} metal/rough maps split from ${res.splits.length / 2} packed texture(s)`);
                return packZip(built, { [`${built.modelName}.fbx`]: new Blob([res.fbx], { type: 'application/octet-stream' }) }, stage, 5);
            });
        });
    }

    function _downloadGLBSync() {
        try {
            function pad(o) { return o % 4 ? o + (4 - o % 4) : o; }

            const allNodes = window.allmodel;
            const nodeMap = new Map();
            const nodes = [];

            allNodes.forEach((obj, idx) => {
                nodeMap.set(obj, idx);
                const name = obj._name || (obj.stateset && obj.stateset._name) || (`mesh_${idx}`);
                const world = computeWorldMatrix(obj);
                nodes.push({ name, matrix: world, mesh: undefined, children: [] });
            });

            const meshes = [], accs = [], bvs = [], mats = [];
            const skippedNodes = {};    // node index -> true for wireframe overlay meshes that are not exported
            let sceneSizeLocal = 0, sceneSizeWorld = 0;   // largest mesh diagonal (mesh units / world units), for key reduction
            const matsChannelInfo = {}; // mi -> { channelName: {url, name} }
            const matsFlat = {};        // mi -> { channelName: {enable, factor, color} } from the material model
            let binChunks = [], off = 0;   // Uint8Array chunks, joined once at the end
            const matHasUV = {};
            const meshHasSkinning = {};
            const morphInfo = {};   // mIdx -> { meshIdx, n } for meshes with morph targets

            function addBV(ta, target) {
                const len = ta.byteLength;
                const al = pad(off), padn = al - off;
                if (padn > 0) { binChunks.push(new Uint8Array(padn)); off += padn; }
                const idx = bvs.length;
                const bv = { buffer: 0, byteOffset: off, byteLength: len };
                if (target) bv.target = target;
                bvs.push(bv);
                const bytes = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
                binChunks.push(bytes);
                off += len;
                return idx;
            }

            allNodes.forEach((obj, mIdx) => {
                if (!obj._primitives) return;
                const mdl = parseobj(obj);
                if (!mdl.vertex || mdl.vertex.length === 0) return;
                const nm = obj._name || (obj.stateset && obj.stateset._name) || (`mesh_${mIdx}`);
                const vc = mdl.vertex.length / 3;

                const twinIdx = wireOverlayTwin(allNodes, mIdx);
                if (twinIdx >= 0) {
                    const twinObj = allNodes[twinIdx];
                    log('mesh ' + nm + ': skipped, it is the wireframe overlay (lines only) of "' +
                        (twinObj._name || (twinObj.stateset && twinObj.stateset._name) || (`mesh_${twinIdx}`)) + '"');
                    skippedNodes[mIdx] = true;
                    return;
                }

                const posArr = new Float32Array(mdl.vertex);
                const posMin = [Infinity, Infinity, Infinity];
                const posMax = [-Infinity, -Infinity, -Infinity];
                for (let pi = 0; pi < posArr.length; pi += 3) {
                    for (let ci = 0; ci < 3; ci++) {
                        const v = posArr[pi + ci];
                        if (v < posMin[ci]) posMin[ci] = v;
                        if (v > posMax[ci]) posMax[ci] = v;
                    }
                }
                const accPos = accs.length;
                accs.push({ bufferView: addBV(posArr, 34962), componentType: 5126,
                            count: vc, type: 'VEC3', min: posMin, max: posMax });
                const dgl = Math.sqrt(Math.pow(posMax[0] - posMin[0], 2) + Math.pow(posMax[1] - posMin[1], 2) + Math.pow(posMax[2] - posMin[2], 2));
                if (isFinite(dgl)) {
                    let wmS = nodes[nodeMap.get(obj)] && nodes[nodeMap.get(obj)].matrix, wsc = 1;
                    if (wmS && wmS.length === 16) {
                        wsc = 0;
                        for (let wc = 0; wc < 3; wc++) wsc = Math.max(wsc, Math.sqrt(wmS[wc * 4] * wmS[wc * 4] + wmS[wc * 4 + 1] * wmS[wc * 4 + 1] + wmS[wc * 4 + 2] * wmS[wc * 4 + 2]));
                    }
                    if (dgl > sceneSizeLocal) sceneSizeLocal = dgl;
                    if (dgl * wsc > sceneSizeWorld) sceneSizeWorld = dgl * wsc;
                }

                let aN = -1, aU = -1, aI = -1, aJ = -1, aW = -1;
                if (mdl.normal.length) {
                    // Some meshes carry normals scaled by their instance transform; glTF needs unit length.
                    mdl.normal = unitNormals(mdl.normal);
                    aN = accs.length;
                    accs.push({ bufferView: addBV(new Float32Array(mdl.normal), 34962),
                                componentType: 5126, count: vc, type: 'VEC3' });
                }
                if (mdl.uv.length) {
                    // glTF uses top-left UV origin; Sketchfab's osgjs uses
                    // bottom-left. Flip V (index 1 of each pair) so the
                    // texture lands right-side up. Keep this export-local:
                    // if we later add an FBX path, FBX may not want it.
                    const uvArr = new Float32Array(mdl.uv);
                    for (let uvi = 1; uvi < uvArr.length; uvi += 2) {
                        uvArr[uvi] = 1 - uvArr[uvi];
                    }
                    aU = accs.length;
                    accs.push({ bufferView: addBV(uvArr, 34962),
                                componentType: 5126, count: vc, type: 'VEC2' });
                    matHasUV[nm] = true;
                }
                // Vertex colors (Sketchfab "Color" attribute). Uint8 RGBA is written as a
                // normalized UNSIGNED_BYTE VEC4; float RGBA as FLOAT VEC4; RGB is widened
                // to float VEC3 (3-byte ubyte elements are not 4-byte aligned in glTF).
                let aC = -1, colArr = mdl.color;
                if (colArr && colArr.length) {
                    const isU8 = (colArr instanceof Uint8Array || colArr instanceof Uint8ClampedArray);
                    const conv = !!CONFIG.VERTEX_COLOR_SRGB;
                    const cStride = (colArr.length === vc * 4) ? 4 : ((colArr.length === vc * 3) ? 3 : 0);
                    if (cStride && !conv && cStride === 4) {
                        aC = accs.length;
                        if (isU8) {
                            accs.push({ bufferView: addBV(new Uint8Array(colArr), 34962), componentType: 5121,
                                        normalized: true, count: vc, type: 'VEC4' });
                        } else {
                            accs.push({ bufferView: addBV(new Float32Array(colArr), 34962), componentType: 5126,
                                        count: vc, type: 'VEC4' });
                        }
                        log('vertex colors:', nm, isU8 ? '(RGBA8)' : '(RGBA float)');
                    } else if (cStride) {
                        // Float output (RGB widened since 3-byte ubyte elements are not 4-byte
                        // aligned). With VERTEX_COLOR_SRGB the RGB channels go sRGB -> linear.
                        const cf = new Float32Array(colArr.length);
                        for (let cfi = 0; cfi < cf.length; cfi++) {
                            let cv = isU8 ? colArr[cfi] / 255 : colArr[cfi];
                            if (conv && (cStride === 3 || cfi % 4 !== 3)) {
                                cv = (cv <= 0.04045) ? cv / 12.92 : Math.pow((cv + 0.055) / 1.055, 2.4);
                            }
                            cf[cfi] = cv;
                        }
                        aC = accs.length;
                        accs.push({ bufferView: addBV(cf, 34962), componentType: 5126, count: vc, type: cStride === 4 ? 'VEC4' : 'VEC3' });
                        log('vertex colors:', nm, cStride === 4 ? '(RGBA)' : '(RGB)', conv ? 'sRGB->linear' : 'as is');
                    } else {
                        warn('vertex colors: unexpected length', colArr.length, 'for', vc, 'vertices on', nm, ', skipped');
                    }
                }
                // A mesh can carry several index primitives (a triangle list plus extra
                // lists, strips or fans). Merge every triangle-type primitive into one
                // TRIANGLES list so no faces go missing; other modes (points, lines) are
                // only used when the mesh has no triangle primitive at all.
                let mergedInd = null, mergedMode = 4;
                if (mdl.primitives.length > 0) {
                    let triParts = [], skippedP = 0, modeLog = [];
                    mdl.primitives.forEach((pr) => {
                        let pm = (pr.mode === undefined || pr.mode === null) ? 4 : pr.mode, pi2 = pr.indices, tl = [], t2;
                        modeLog.push(`${pm}x${pi2 ? pi2.length : 0}`);
                        if (!pi2 || !pi2.length) return;
                        // Degenerate triangles (repeated index) are strip joins; drop them so
                        // Blender does not show long zero-area edges between distant vertices.
                        let oobN = 0, degN = 0, tpos = [];
                        function addTri(a, b, c) {
                            if (a !== b && b !== c && a !== c && a < vc && b < vc && c < vc) { tl.push(a, b, c); tpos.push(t2); }
                            else if (a >= vc || b >= vc || c >= vc) oobN++;
                            else degN++;
                        }
                        // An index >= vertex count (WebGL2 primitive restart value 65535 / 4294967295) ends a
                        // strip or fan: restart the winding parity after it instead of treating it as a vertex.
                        let rs = 0;
                        if (pm === 4) {
                            for (t2 = 0; t2 + 2 < pi2.length; t2 += 3) addTri(pi2[t2], pi2[t2 + 1], pi2[t2 + 2]);
                        } else if (pm === 5) {
                            for (t2 = 0; t2 < pi2.length; t2++) {
                                if (pi2[t2] >= vc) { rs = t2 + 1; oobN++; continue; }
                                if (t2 - rs < 2) continue;
                                if ((t2 - rs) % 2 === 0) addTri(pi2[t2 - 2], pi2[t2 - 1], pi2[t2]);
                                else addTri(pi2[t2 - 1], pi2[t2 - 2], pi2[t2]);
                            }
                        } else if (pm === 6) {
                            for (t2 = 0; t2 < pi2.length; t2++) {
                                if (pi2[t2] >= vc) { rs = t2 + 1; oobN++; continue; }
                                if (t2 - rs < 2) continue;
                                addTri(pi2[rs], pi2[t2 - 1], pi2[t2]);
                            }
                        } else { skippedP++; return; }
                        // Diagnostic for stray long thin triangles ("stripes"): flag triangles whose longest edge is
                        // far above the typical edge of this mesh and print where they come from in the index list.
                        if (tl.length) (() => {
                            let vv = mdl.vertex, nT = tl.length / 3, q, lens = [], mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
                            function el(i, j) { const dx = vv[i * 3] - vv[j * 3], dy = vv[i * 3 + 1] - vv[j * 3 + 1], dz = vv[i * 3 + 2] - vv[j * 3 + 2]; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
                            for (q = 0; q < vc; q++) for (let ax = 0; ax < 3; ax++) { const cv = vv[q * 3 + ax]; if (cv < mn[ax]) mn[ax] = cv; if (cv > mx[ax]) mx[ax] = cv; }
                            const size = Math.sqrt(Math.pow(mx[0] - mn[0], 2) + Math.pow(mx[1] - mn[1], 2) + Math.pow(mx[2] - mn[2], 2));
                            const step = Math.max(1, Math.floor(nT / 2000));
                            for (q = 0; q < nT; q += step) lens.push(Math.max(el(tl[q * 3], tl[q * 3 + 1]), el(tl[q * 3 + 1], tl[q * 3 + 2]), el(tl[q * 3], tl[q * 3 + 2])));
                            lens.sort((a, b) => a - b);
                            let med = lens[lens.length >> 1] || 0, lim = Math.max(20 * med, 0.05 * size), hits = 0, shown = 0, drop = {}, nDrop = 0, cand = [];
                            for (q = 0; q < nT; q++) {
                                const a0 = tl[q * 3], b0 = tl[q * 3 + 1], c0 = tl[q * 3 + 2];
                                const L = Math.max(el(a0, b0), el(b0, c0), el(a0, c0));
                                if (!(L > lim)) continue;
                                hits++;
                                // Bridging triangle of a strip join without repeated vertices: very long and almost no width.
                                const ux = vv[b0 * 3] - vv[a0 * 3], uy = vv[b0 * 3 + 1] - vv[a0 * 3 + 1], uz = vv[b0 * 3 + 2] - vv[a0 * 3 + 2];
                                const wx = vv[c0 * 3] - vv[a0 * 3], wy = vv[c0 * 3 + 1] - vv[a0 * 3 + 1], wz = vv[c0 * 3 + 2] - vv[a0 * 3 + 2];
                                const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
                                const height = Math.sqrt(cx * cx + cy * cy + cz * cz) / L;   // 2*area / longest edge
                                if (CONFIG.DROP_STRIP_SLIVERS && (pm === 5 || pm === 6) && height < 2 * med) cand.push(q);
                                if (shown < 3 && CONFIG.DROP_STRIP_SLIVERS && (pm === 5 || pm === 6) && height < 2 * med) {
                                    shown++;
                                    const at = tpos[q], ctx = [];
                                    for (let ci = Math.max(0, at - 5); ci <= Math.min(pi2.length - 1, at + 3); ci++) ctx.push((ci === at ? '*' : '') + pi2[ci]);
                                    log('long triangle:', nm, `mode ${pm}`, 'tri (' + a0 + ',' + b0 + ',' + c0 + ') longest edge ' + L.toFixed(3) +
                                        ' (typical ' + med.toFixed(4) + ', mesh size ' + size.toFixed(3) + ') at index ' + at + ' of ' + pi2.length + ', indices around: ' + ctx.join(' '));
                                }
                            }
                            // A bridging triangle spans a gap: one of its long edges is used by no other triangle
                            // (vertices welded by position). Long thin tubes/rods share every long edge, so they stay.
                            if (cand.length) {
                                let qs = Math.max(size * 1e-6, 1e-9), wmap = {}, wid = new Int32Array(vc), nw = 0, vi;
                                for (vi = 0; vi < vc; vi++) {
                                    const wk = `${Math.round(vv[vi * 3] / qs)},${Math.round(vv[vi * 3 + 1] / qs)},${Math.round(vv[vi * 3 + 2] / qs)}`;
                                    if (wmap[wk] === undefined) wmap[wk] = nw++;
                                    wid[vi] = wmap[wk];
                                }
                                const ek = (i, j) => { const a1 = wid[i], b1 = wid[j]; return a1 < b1 ? `${a1}_${b1}` : `${b1}_${a1}`; };
                                let ecount = {}, ci2, e3;
                                for (ci2 = 0; ci2 < cand.length; ci2++) {
                                    const cq = cand[ci2], cv3 = [tl[cq * 3], tl[cq * 3 + 1], tl[cq * 3 + 2]];
                                    for (e3 = 0; e3 < 3; e3++) if (el(cv3[e3], cv3[(e3 + 1) % 3]) > lim) ecount[ek(cv3[e3], cv3[(e3 + 1) % 3])] = 0;
                                }
                                for (q = 0; q < nT; q++) for (e3 = 0; e3 < 3; e3++) {
                                    const k3 = ek(tl[q * 3 + e3], tl[q * 3 + (e3 + 1) % 3]);
                                    if (ecount[k3] !== undefined) ecount[k3]++;
                                }
                                // A bridge joins real geometry at both ends of its open edge; a free thin card (wire,
                                // grass, hair strip) does not, so it stays.
                                const isCand = {}, onReal = new Uint8Array(nw);
                                for (ci2 = 0; ci2 < cand.length; ci2++) isCand[cand[ci2]] = true;
                                for (q = 0; q < nT; q++) if (!isCand[q]) { onReal[wid[tl[q * 3]]] = 1; onReal[wid[tl[q * 3 + 1]]] = 1; onReal[wid[tl[q * 3 + 2]]] = 1; }
                                for (ci2 = 0; ci2 < cand.length; ci2++) {
                                    let cq2 = cand[ci2], cw = [tl[cq2 * 3], tl[cq2 * 3 + 1], tl[cq2 * 3 + 2]], open = false;
                                    for (e3 = 0; e3 < 3; e3++) {
                                        const ka = ek(cw[e3], cw[(e3 + 1) % 3]);
                                        if (ecount[ka] === 1 && onReal[wid[cw[e3]]] && onReal[wid[cw[(e3 + 1) % 3]]]) open = true;
                                    }
                                    if (open) { drop[cq2] = true; nDrop++; }
                                }
                            }
                            if (nDrop) {
                                const kept = [];
                                for (q = 0; q < nT; q++) if (!drop[q]) kept.push(tl[q * 3], tl[q * 3 + 1], tl[q * 3 + 2]);
                                tl = kept;
                                log(`mesh ${nm}: dropped ${nDrop} bridging sliver triangle(s) from the strip (stripes)`);
                            }
                            if (hits > nDrop) log(`mesh ${nm}: ${hits - nDrop} long thin triangle(s) kept (real geometry, edges shared)`);
                        })();
                        if (oobN) log('indices:', nm, `mode ${pm}`, `${pi2.length} indices ->`, `${tl.length / 3} triangles, restart/out-of-range ${oobN}, degenerate ${degN}, vertices ${vc}`);
                        triParts.push(tl);
                    });
                    if (mdl.primitives.length > 1) log('primitives:', nm, mdl.primitives.length, `(mode x indices: ${modeLog.join(', ')})`);
                    if (triParts.length) {
                        mergedInd = [];
                        triParts.forEach((tl) => { for (let tq = 0; tq < tl.length; tq++) mergedInd.push(tl[tq]); });
                        if (skippedP) warn('mesh', nm, ':', skippedP, 'non-triangle primitive(s) not exported');
                    }
                }
                let noTris = false;
                if (mergedInd && !mergedInd.length) { warn('mesh', nm, ': no valid triangles after merge, exported as points'); mergedInd = null; noTris = true; }
                if (mergedInd) {
                    let mxm = 0;
                    for (let km = 0; km < mergedInd.length; km++) if (mergedInd[km] > mxm) mxm = mergedInd[km];
                    const idxM = mxm < 65535 ? new Uint16Array(mergedInd) : new Uint32Array(mergedInd);
                    aI = accs.length;
                    accs.push({ bufferView: addBV(idxM, 34963),
                                componentType: idxM instanceof Uint32Array ? 5125 : 5123,
                                count: mergedInd.length, type: 'SCALAR' });
                } else if (!noTris && mdl.primitives.length > 0 && mdl.primitives[0].indices && mdl.primitives[0].indices.length > 0) {
                    let ind = mdl.primitives[0].indices, mx = 0;
                    for (let k = 0; k < ind.length; k++) if (ind[k] > mx) mx = ind[k];
                    if (mx >= vc) {
                        warn('mesh', nm, ': indices out of range, exported as points');
                        noTris = true;
                    } else {
                        const idxD = mx < 65535 ? new Uint16Array(ind) : new Uint32Array(ind);
                        aI = accs.length;
                        accs.push({ bufferView: addBV(idxD, 34963),
                                    componentType: idxD instanceof Uint32Array ? 5125 : 5123,
                                    count: ind.length, type: 'SCALAR' });
                    }
                }

                const expected = vc * 4;
                if (mdl.joints && mdl.weights &&
                    mdl.joints.length === expected && mdl.weights.length === expected) {
                    let mj = 0;
                    for (let jj = 0; jj < mdl.joints.length; jj++) if (mdl.joints[jj] > mj) mj = mdl.joints[jj];
                    const jD = mj <= 255 ? new Uint8Array(mdl.joints) : new Uint16Array(mdl.joints);
                    // A joint index used with weight 0 is invalid in glTF (validator
                    // ACCESSOR_JOINTS_USED_ZERO_WEIGHT): point such slots at joint 0.
                    for (let zj = 0; zj < jD.length; zj++) if (!(mdl.weights[zj] > 0)) jD[zj] = 0;
                    aJ = accs.length;
                    accs.push({ bufferView: addBV(jD, 34962),
                                componentType: mj <= 255 ? 5121 : 5123,
                                count: vc, type: 'VEC4' });
                    aW = accs.length;
                    accs.push({ bufferView: addBV(new Float32Array(mdl.weights), 34962),
                                componentType: 5126, count: vc, type: 'VEC4' });
                    meshHasSkinning[mIdx] = mj + 1;
                    log('skinned mesh:', nm, `jointsMax=${mj}`);
                }

                // Morph targets. The viewer blends  (1 - sum w) * base + sum w_k * target_k  with
                // absolute targets, which equals glTF's  base + sum w_k * (target_k - base).
                const morphTargets = [], mAttr = obj._attributes || {};
                function morphEls(a) {
                    const b = a && (a._initialBufferArray || a._bufferArray);
                    return (b && b._elements) || (a && a._elements) || null;
                }
                for (let mk = 0, mN = morphTargetCount(obj); mk < mN; mk++) {
                    const tv = morphEls(mAttr[`Vertex_${mk}`]);
                    if (!tv || tv.length !== mdl.vertex.length) {
                        warn('morph target', mk, 'of', nm, 'skipped (vertex data missing or wrong size)');
                        continue;
                    }
                    const dv = new Float32Array(tv.length), dMin = [Infinity, Infinity, Infinity], dMax = [-Infinity, -Infinity, -Infinity];
                    for (let di = 0; di < tv.length; di++) {
                        const dd = tv[di] - mdl.vertex[di];
                        dv[di] = dd;
                        const dax = di % 3;
                        if (dd < dMin[dax]) dMin[dax] = dd;
                        if (dd > dMax[dax]) dMax[dax] = dd;
                    }
                    const tgt = { POSITION: accs.length };
                    accs.push({ bufferView: addBV(dv, 34962), componentType: 5126, count: vc,
                                type: 'VEC3', min: dMin, max: dMax });
                    let tn = morphEls(mAttr[`Normal_${mk}`]);
                    if (tn && mdl.normal.length && tn.length === mdl.normal.length) {
                        tn = unitNormals(tn);
                        const dn = new Float32Array(tn.length);
                        for (let dni = 0; dni < tn.length; dni++) dn[dni] = tn[dni] - mdl.normal[dni];
                        tgt.NORMAL = accs.length;
                        accs.push({ bufferView: addBV(dn, 34962), componentType: 5126, count: vc, type: 'VEC3' });
                    }
                    morphTargets.push(tgt);
                }
                if (morphTargets.length) log('morph targets:', nm, morphTargets.length);

                const primMode = noTris ? 0 : mergedInd ? 4 : ((mdl.primitives.length > 0 && typeof mdl.primitives[0].mode === 'number') ? mdl.primitives[0].mode : 4);
                const prim = { attributes: { POSITION: accPos }, mode: primMode };
                if (aN >= 0) prim.attributes.NORMAL = aN;
                if (aU >= 0) prim.attributes.TEXCOORD_0 = aU;
                if (aC >= 0) prim.attributes.COLOR_0 = aC;
                if (aJ >= 0) prim.attributes.JOINTS_0 = aJ;
                if (aW >= 0) prim.attributes.WEIGHTS_0 = aW;
                if (aI >= 0) prim.indices = aI;
                if (morphTargets.length) prim.targets = morphTargets;

                let mi = -1;
                for (let q = 0; q < mats.length; q++) if (mats[q].name === nm) { mi = q; break; }
                if (mi === -1) {
                    mi = mats.length;
                    mats.push({ name: nm, pbrMetallicRoughness: {
                        baseColorFactor: [1,1,1,1], metallicFactor: 1, roughnessFactor: 1 } });
                    matsChannelInfo[mi] = getChannelTextureMap(obj);
                    matsFlat[mi] = getMaterialChannels(obj);
                }
                prim.material = mi;

                const mshIdx = meshes.length;
                if (morphTargets.length) morphInfo[mIdx] = { meshIdx: meshes.length, n: morphTargets.length };
                meshes.push({ name: nm, primitives: [prim] });
                const ni = nodeMap.get(obj);
                if (ni !== undefined) nodes[ni].mesh = mshIdx;
            });

            let images = [], textures = [], imageKeys = [], usedSafe = {};
            const textureUrlToIndex  = {};
            const textureNameToIndex = {};
            for (let key in saveimagecache2) {
                if (!saveimagecache2.hasOwnProperty(key)) continue;
                const t = saveimagecache2[key];
                if (!t || !t.dataURL) continue;
                const ext = t.fileExt || '.png';
                if (!objects[(t.name || 'texture') + ext]) { warn(`texture file missing, not referenced: ${t.name || 'texture'}${ext}`); continue; }
                // ASCII-safe file name: no encoding issues in URIs or zip loaders.
                const safeBase = String(t.name || 'texture').replace(/[^A-Za-z0-9._-]+/g, '_') || 'texture';
                let safeName = safeBase + ext, sc = 1;
                while (usedSafe[safeName.toLowerCase()]) safeName = `${safeBase}_${sc++}${ext}`;   // case-insensitive file systems
                usedSafe[safeName.toLowerCase()] = true;
                const path = `textures/${safeName}`;
                const ii = images.length;
                imageKeys.push({ key: (t.name || 'texture') + ext, safe: safeName });
                images.push({ uri: path });
                textures.push({ source: ii });
                const nu = normalizeUrl(key);
                if (nu) textureUrlToIndex[nu] = ii;
                const sn = sanitizeTextureName(t.name);
                if (sn) textureNameToIndex[sn] = ii;
            }

            function findTexIdx(info) {
                if (!info) return undefined;
                const u = normalizeUrl(info.url);
                if (u && textureUrlToIndex[u] !== undefined) return textureUrlToIndex[u];
                const n = sanitizeTextureName(info.name);
                if (n && textureNameToIndex[n] !== undefined) return textureNameToIndex[n];
                return undefined;
            }

            function flatEm(fl) {
                const e = fl && fl.EmitColor;
                const f = (e && typeof e.factor === 'number') ? e.factor : 1;
                return Math.max(0, Math.min(1, f));
            }

            // Channels the viewer shows with a texture that did not make it into the export.
            mats.forEach((m, mi) => {
                const chan = matsChannelInfo[mi] || {};
                (() => {
                    const fl = matsFlat[mi], mp = fl && fl.__map, lost = [], atl = [];
                    if (mp) for (let mk2 in mp) {
                        if (!mp.hasOwnProperty(mk2) || !(mp[mk2] >= 0) || mk2 === 'Inspector' || mk2 === 'Matcap') continue;
                        const inf = chan[mk2];
                        if (!inf || inf.atlas || !(inf.url || inf.name)) { atl.push(mk2); continue; }
                        if (findTexIdx(inf) === undefined) lost.push(mk2);
                    }
                    if (lost.length) warn(`material ${m.name}: channels with a texture in the viewer but not in the export: ${lost.join(', ')}`);
                    if (atl.length) log(`material ${m.name}: colour atlas / no image for ${atl.join(', ')}, using flat material values`);
                })();
            });
            let anyRealTex = false;
            for (let cmi in matsChannelInfo) {
                if (!matsChannelInfo.hasOwnProperty(cmi) || !matsChannelInfo[cmi]) continue;
                for (let ck in matsChannelInfo[cmi]) {
                    const ci = matsChannelInfo[cmi][ck];
                    if (matsChannelInfo[cmi].hasOwnProperty(ck) && ci && (ci.url || ci.name) && !ci.atlas) anyRealTex = true;
                }
            }
            if (!textures.length && mats.length && anyRealTex) warn('no textures were captured at all: reload the page, wait until the model is fully shown, then export (see tools/probe-textures.js if it keeps happening)');

            if (textures.length) {
                mats.forEach((m, mi) => {
                    if (!matHasUV[m.name]) return;
                    const chan = matsChannelInfo[mi] || {};
                    let assigned = false;

                    const albedo = chan.AlbedoPBR || chan.DiffusePBR || chan.BaseColorPBR || chan.DiffuseColor;
                    const ai = findTexIdx(albedo);
                    if (ai !== undefined) {
                        m.pbrMetallicRoughness.baseColorTexture = { index: ai };
                        assigned = true;
                    }

                    const nrm = chan.NormalMap || chan.NormalPBR;
                    const ni = findTexIdx(nrm);
                    if (ni !== undefined) {
                        m.normalTexture = { index: ni };
                        assigned = true;
                    }

                    const ao = chan.AOPBR || chan.OcclusionPBR;
                    const oi = findTexIdx(ao);
                    if (oi !== undefined) {
                        m.occlusionTexture = { index: oi };
                        assigned = true;
                    }

                    const em = chan.EmissivePBR || chan.EmissionPBR || chan.EmitColor;
                    const ei = findTexIdx(em);
                    if (ei !== undefined) {
                        m.emissiveTexture = { index: ei };
                        // glTF multiplies the texture by emissiveFactor (default 0 = no emission).
                        const emF = flatEm(matsFlat[mi]);
                        m.emissiveFactor = [emF, emF, emF];
                        assigned = true;
                    }

                    // Merged MR (see mergeMRTextures): registered in the
                    // pool under name "<sanitized mesh name>_MR".
                    const mrName = `${sanitizeTextureName(m.name)}_MR`;
                    const mrIdx = textureNameToIndex[mrName];
                    if (mrIdx !== undefined) {
                        m.pbrMetallicRoughness.metallicRoughnessTexture = { index: mrIdx };
                        assigned = true;
                    }

                    // Merged opacity (see mergeOpacityTextures): the RGBA texture
                    // replaces the plain base color and the material blends.
                    const alphaIdx = textureNameToIndex[`${_alphaShare[sanitizeTextureName(m.name)] || sanitizeTextureName(m.name)}_Alpha`];
                    if (alphaIdx !== undefined) {
                        m.pbrMetallicRoughness.baseColorTexture = { index: alphaIdx };
                        if (_opacityKind[sanitizeTextureName(m.name)] === 'alphamask') {
                            m.alphaMode = 'MASK'; m.alphaCutoff = 0.5;
                        } else {
                            m.alphaMode = 'BLEND';
                        }
                        assigned = true;
                        log(`material ${m.name}: alphaMode ${m.alphaMode} with merged ${_opacityKind[sanitizeTextureName(m.name)] || 'opacity'} texture`);
                    }

                    if (!assigned) {
                        // No texture of this material was captured. Do not borrow texture 0
                        // (an unrelated image); keep the plain material and say so.
                        warn('material ' + m.name + ': no texture found in the capture pool, exported without textures'
                             + (CONFIG.TEXTURE_WAIT_SECONDS ? '' : ' (texture wait is off)'));
                    }
                });
            }

            // Flat material values for channels without a texture (texture-less models): base
            // color, metalness, roughness, emission. Textured channels keep factor 1 so the
            // texture alone decides, as before.
            mats.forEach((m, mi) => {
                const flat = matsFlat[mi], chan = matsChannelInfo[mi] || {}, pbr = m.pbrMetallicRoughness;
                if (!flat) return;
                const did = [];
                const cmap = flat.__map;
                function texd(n) {
                    // A channel counts as textured only when it has a real image (url or name) that is not
                    // the generated colour atlas; otherwise the flat material value is the best data we have.
                    const real = !!(chan[n] && (chan[n].url || chan[n].name) && !chan[n].atlas);
                    if (cmap && typeof cmap[n] === 'number') return cmap[n] >= 0 && real;
                    return real;
                }
                const chKeys = [];
                for (let chk in chan) if (chan.hasOwnProperty(chk) && (chan[chk].url || chan[chk].name)) chKeys.push(chk);
                const mapKeys = [];
                if (cmap) for (let mpk in cmap) if (cmap.hasOwnProperty(mpk) && cmap[mpk] >= 0) mapKeys.push(`${mpk}=${cmap[mpk]}`);
                log('material ' + m.name + ': texture channels [' + chKeys.join(',') + '] mapping [' + mapKeys.join(',') + ']' +
                    (pbr.baseColorTexture ? ' baseColorTexture set' : ' no baseColorTexture'));
                const alb = flat.AlbedoPBR;
                const alphaOnlyTex = !!_opacityNoColor[sanitizeTextureName(m.name)];
                if (alb && alb.enable && (alb.color || typeof alb.factor === 'number') && (!pbr.baseColorTexture || alphaOnlyTex) && !texd('AlbedoPBR') && !texd('DiffusePBR')) {
                    // No colour value means white scaled by the factor (factor 0 = black base, colour from emission only).
                    const af = (typeof alb.factor === 'number') ? alb.factor : 1, ac = alb.color || [1, 1, 1];
                    const aa = (pbr.baseColorFactor && pbr.baseColorFactor[3] !== undefined) ? pbr.baseColorFactor[3] : 1;
                    pbr.baseColorFactor = [Math.min(1, ac[0] * af), Math.min(1, ac[1] * af), Math.min(1, ac[2] * af), aa];
                    did.push('base color');
                }
                const mt = flat.MetalnessPBR, rg = flat.RoughnessPBR;
                // Merged MR image: a missing map is stored as 255, so the factor carries the flat value.
                const mrE = saveimagecache2[`__merged_mr__:${sanitizeTextureName(m.name)}`], mrTex = !!pbr.metallicRoughnessTexture;
                const mFlat = !texd('MetalnessPBR') && !(mrTex && mrE && mrE.hasM);
                const rFlat = !texd('RoughnessPBR') && !(mrTex && mrE && mrE.hasR);
                if (mrTex && !(mrE && mrE.hasM)) pbr.metallicFactor = 0;   // non-metal unless a flat value follows
                if (mt && mt.enable && typeof mt.factor === 'number' && mFlat) {
                    pbr.metallicFactor = CONFIG.FLAT_MR_FROM_VIEWER ? mt.factor : 0; did.push('metalness');
                }
                if (rg && rg.enable && typeof rg.factor === 'number' && rFlat) {
                    pbr.roughnessFactor = CONFIG.FLAT_MR_FROM_VIEWER ? rg.factor : 0.5; did.push('roughness');
                }
                const op = flat.Opacity || flat.AlphaMask;
                if (op && op.enable && pbr.baseColorTexture && !m.alphaMode && _opacityOneFile[sanitizeTextureName(m.name)]) {
                    const isBlend = !!flat.Opacity && /blend/i.test(String(op.type || ''));
                    m.alphaMode = isBlend ? 'BLEND' : 'MASK';
                    if (!isBlend) m.alphaCutoff = 0.5;
                    did.push(`opacity ${m.alphaMode} (${op.type})`);
                }
                // Opacity given as a plain value (no mask image): use it as base colour alpha.
                const opf = flat.Opacity;
                if (opf && opf.enable && !m.alphaMode && !texd('Opacity') && typeof opf.factor === 'number' && opf.factor < 0.999) {
                    if (!pbr.baseColorFactor) pbr.baseColorFactor = [1, 1, 1, 1];
                    pbr.baseColorFactor[3] = Math.max(0, Math.min(1, opf.factor));
                    m.alphaMode = 'BLEND';
                    did.push(`opacity ${pbr.baseColorFactor[3].toFixed(2)} (${opf.type})`);
                }
                if (mt && mt.enable === false && mFlat) {
                    pbr.metallicFactor = 0; did.push('metalness off');
                }
                const em = flat.EmitColor;
                if (em && em.enable && em.color && !m.emissiveTexture && !texd('EmitColor')) {
                    const ef = (typeof em.factor === 'number') ? em.factor : 1;
                    const ev = [Math.min(1, em.color[0] * ef), Math.min(1, em.color[1] * ef), Math.min(1, em.color[2] * ef)];
                    if (ev[0] > 0 || ev[1] > 0 || ev[2] > 0) { m.emissiveFactor = ev; did.push('emission'); }
                }
                if (did.length) log(`material ${m.name}: flat values from material model (${did.join(', ')})`);
            });

            // Sketchfab can render a model two-sided (Inspector: Single Sided OFF), which glTF
            // expresses per material. We cannot read that setting yet, so it is a manual option.
            if (CONFIG.DOUBLE_SIDED) {
                const singleNames = [];
                mats.forEach((m, mi) => {
                    const cv = matsFlat[mi] ? matsFlat[mi].__cull : undefined;   // 1029 (GL_BACK) = Single Sided ON, 0 = OFF
                    const on = !(cv === undefined || cv === null || cv === 0 || cv === false || /^(none|0|false|off)?$/i.test(String(cv)));
                    if (CONFIG.DOUBLE_SIDED_AUTO && on) { singleNames.push(m.name); return; }
                    m.doubleSided = true;
                });
                log('materials marked doubleSided: ' + (mats.length - singleNames.length) + ' of ' + mats.length +
                    (singleNames.length ? ` (single sided in the viewer: ${singleNames.join(', ')})` : ''));
            }

            // ---- animation clips (multi-clip aware) ----
            const mlA = document.getElementsByClassName('model-name__label')[0];
            const animBase = mlA ? mlA.textContent.trim().replace(/\.+$/, '') : 'model';
            let clipSets = [];
            if (window.clips && window.clips.length > 1) {
                window.clips.forEach((c) => {
                    if (c && c.frames && c.frames.length > 1) {
                        clipSets.push({ name: c.name, frames: c.frames });
                    }
                });
            }
            if (clipSets.length > 1) {
                log(`export: multi-clip mode, clips=${clipSets.length}`);
            } else {
                // single-clip path: same data source and behaviour as before
                clipSets = (window.recordedFrames.length > 1)
                    ? [{ name: `${animBase}_anim`, frames: window.recordedFrames }] : [];
            }
            const hasFrames = clipSets.length > 0;
            const liveSnap = hasFrames ? null : snapshotFrame().meshes;
            const gltfSkins = [];
            let animations;

            // One sampler + channel. With REDUCE_KEYS, keys that interpolation already reproduces are left
            // out and the channel gets its own, shorter time accessor. timeAccFn creates the full time
            // accessor only when it is used, so no unused data is written.
            const keyStats = { before: 0, after: 0 };
            function lazyTimeAcc(times) {
                let idx = -1;
                return () => {
                    if (idx < 0) {
                        idx = accs.length;
                        accs.push({ bufferView: addBV(new Float32Array(times)), componentType: 5126, count: times.length,
                                    type: 'SCALAR', min: [times[0]], max: [times[times.length - 1]] });
                    }
                    return idx;
                };
            }
            function emitSampler(tr, times, timeAccFn, data, n, type, nodeIdx, path, transTol) {
                let outArr = data, count = times.length, tAcc = -1, q, c;
                if (CONFIG.REDUCE_KEYS && count > 2) {
                    let tol;
                    if (path === 'rotation') tol = 1e-4;
                    else if (path === 'scale') {
                        let mxa = 0;
                        for (q = 0; q < data.length; q++) if (Math.abs(data[q]) > mxa) mxa = Math.abs(data[q]);
                        tol = 1e-4 * mxa;
                    } else tol = transTol;
                    const keep = reduceKeys(times, data, n, tol, path === 'rotation', 32);
                    keyStats.before += count; keyStats.after += keep.length;
                    if (keep.length < count) {
                        const nt = [], nd = [];
                        for (q = 0; q < keep.length; q++) {
                            nt.push(times[keep[q]]);
                            for (c = 0; c < n; c++) nd.push(data[keep[q] * n + c]);
                        }
                        outArr = nd; count = keep.length;
                        tAcc = accs.length;
                        accs.push({ bufferView: addBV(new Float32Array(nt)), componentType: 5126, count,
                                    type: 'SCALAR', min: [nt[0]], max: [nt[count - 1]] });
                    }
                }
                if (tAcc < 0) tAcc = timeAccFn();
                const aO = accs.length;
                accs.push({ bufferView: addBV(new Float32Array(outArr)), componentType: 5126, count, type });
                tr.samplers.push({ input: tAcc, interpolation: 'LINEAR', output: aO });
                tr.channels.push({ sampler: tr.samplers.length - 1, target: { node: nodeIdx, path } });
            }

            // One time accessor + sampler/channel lists per clip.
            const tracks = clipSets.map((cs) => {
                // Start every clip at exactly t = 0 (the single-clip recorder's first frame
                // lands ~16 ms after the start). Store float32-rounded values so the
                // accessor min/max match the buffer exactly.
                const tFirst = cs.frames[0].time;
                const times = cs.frames.map((f) => Math.fround(f.time - tFirst));
                // The time accessor is created on first use, so a clip without motion adds no unused data.
                let tAcc = -1;
                const trk = { name: cs.name, frames: cs.frames, times, samplers: [], channels: [] };
                Object.defineProperty(trk, 'timeAcc', {
                    enumerable: true,
                    get: () => {
                        if (tAcc < 0) {
                            const tV = addBV(new Float32Array(times));
                            tAcc = accs.length;
                            accs.push({ bufferView: tV, componentType: 5126, count: times.length,
                                        type: 'SCALAR', min: [times[0]], max: [times[times.length - 1]] });
                        }
                        return tAcc;
                    }
                });
                return trk;
            });

            function expandMat3x4(pal, boneIdx) {
                const b = boneIdx * 12;
                return [
                    pal[b + 0], pal[b + 4], pal[b + 8], 0,
                    pal[b + 1], pal[b + 5], pal[b + 9], 0,
                    pal[b + 2], pal[b + 6], pal[b + 10], 0,
                    pal[b + 3], pal[b + 7], pal[b + 11], 1
                ];
            }

            let staticWarned = false;
            allNodes.forEach((obj, mIdx) => {
                if (!meshHasSkinning[mIdx]) return;

                const meshNodeIdx = nodeMap.get(obj);
                if (meshNodeIdx === undefined) return;

                let jointCount = meshHasSkinning[mIdx];
                let paletteRef = null;
                if (hasFrames) {
                    const refFrames = tracks[0].frames;
                    for (let fi = 0; fi < refFrames.length; fi++) {
                        const fm = refFrames[fi].meshes[mIdx];
                        if (fm && fm.palette) {
                            const fromPal = (fm.palette.length / 12) | 0;
                            if (fromPal > jointCount) jointCount = fromPal;
                            paletteRef = fm;
                            break;
                        }
                    }
                }

                const W_mesh = computeWorldMatrix(obj);

                // Real bone hierarchy when the rig can be read and every palette of this export gives
                // local joint matrices that a glTF node can hold exactly (TRS). Otherwise flat joints
                // (one joint per palette entry, identity inverse bind matrices), as before.
                let rig = null;
                const rigInfo = getRigInfo(obj, jointCount);
                let rigFail = rigInfo.fail || '';
                if (!rigFail) {
                    const pals = [];
                    if (hasFrames) tracks.forEach((t) => t.frames.forEach((f) => { const m = f.meshes[mIdx]; if (m && m.palette) pals.push(m.palette); }));
                    else if (liveSnap && liveSnap[mIdx] && liveSnap[mIdx].palette) pals.push(liveSnap[mIdx].palette);
                    const spm = window.staticPoseSnapshot && window.staticPoseSnapshot.meshes[mIdx];
                    if (hasFrames && spm && spm.palette) pals.push(spm.palette);
                    if (!pals.length) rigFail = 'no palette recorded';
                    let worst = 0;
                    for (let pq = 0; pq < pals.length && !rigFail; pq++) {
                        if (pals[pq].length < jointCount * 12) { rigFail = 'a palette is shorter than the bone list'; break; }
                        const L = rigLocals(rigInfo, pals[pq]);
                        if (!L) { rigFail = 'a parent joint is scaled to 0 in some frame'; break; }
                        for (let lj = 0; lj < jointCount; lj++) worst = Math.max(worst, trsError(L[lj]));
                        if (worst > 1e-3) rigFail = `a local joint matrix has shear (${(worst * 100).toFixed(1)}%)`;
                    }
                    if (!rigFail) rig = rigInfo;
                }
                const jointMat = rig ? ((pal, jx) => rigLocals(rig, pal)[jx]) : expandMat3x4;
                if (rig) {
                    const nRoots = rig.parent.filter((p) => p < 0).length;
                    log(`skin ${gltfSkins.length}: bone hierarchy, ${jointCount} bones, ${nRoots} root(s), palette check ${rig.check.toExponential(1)}`);
                } else {
                    log(`skin ${gltfSkins.length}: flat joints (${rigFail})`);
                }

                const skelRootIdx = nodes.length;
                nodes.push({ name: `skel_root_${mIdx}`, matrix: rig ? mulMat4(W_mesh, rig.invT) : W_mesh, children: [] });

                const jointNodeIndices = [];
                for (let ji = 0; ji < jointCount; ji++) {
                    jointNodeIndices.push(nodes.length);
                    nodes.push({ name: rig ? rig.names[ji] : `joint_${mIdx}_${ji}`, children: [] });
                }
                for (let ji = 0; ji < jointCount; ji++) {
                    const pj = rig ? rig.parent[ji] : -1;
                    nodes[pj < 0 ? skelRootIdx : jointNodeIndices[pj]].children.push(jointNodeIndices[ji]);
                }

                const ibmFlat = new Float32Array(jointCount * 16);
                for (let pi2 = 0; pi2 < jointCount; pi2++) {
                    if (rig) { for (let q = 0; q < 16; q++) ibmFlat[pi2 * 16 + q] = rig.ibm[pi2][q]; continue; }
                    ibmFlat[pi2 * 16 + 0]  = 1;
                    ibmFlat[pi2 * 16 + 5]  = 1;
                    ibmFlat[pi2 * 16 + 10] = 1;
                    ibmFlat[pi2 * 16 + 15] = 1;
                }
                const ibmV = addBV(ibmFlat);
                const ibmA = accs.length;
                accs.push({ bufferView: ibmV, componentType: 5126,
                            count: jointCount, type: 'MAT4' });

                const skinIdx = gltfSkins.length;
                gltfSkins.push({
                    inverseBindMatrices: ibmA,
                    joints: jointNodeIndices,
                    skeleton: skelRootIdx
                });

                nodes[meshNodeIdx].skin = skinIdx;
                delete nodes[meshNodeIdx].matrix;

                let decErr = { max: 0, joint: -1, frame: -1, bad: 0 }, holdJoints = 0, ibmFixed = 0;
                // Joints whose matrix has shear get a helper parent node: helper = T*U*S, joint = V^T (exact).
                const helperOf = {};
                function makeHelper(jx) {
                    if (helperOf[jx] !== undefined) return helperOf[jx];
                    const jNode = jointNodeIndices[jx], hIdx = nodes.length;
                    nodes.push({ name: `joint_${mIdx}_${jx}_shear`, children: [jNode] });
                    const kids = nodes[skelRootIdx].children, kp = kids.indexOf(jNode);
                    if (kp >= 0) kids[kp] = hIdx; else kids.push(hIdx);
                    helperOf[jx] = hIdx;
                    return hIdx;
                }
                // Preferred fix for shear: a constant right rotation Q (the SVD's V) goes into the inverse bind
                // matrix (IBM = Q^T) and the joint itself is P*Q = T*U*S, a plain TRS node. Blender can import that
                // exactly (its bones cannot hold a scaled helper node). Only used when Q is constant over all frames.
                const ibmQ = {};
                function q4FromV(V) { return [V[0][0], V[0][1], V[0][2], 0, V[1][0], V[1][1], V[1][2], 0, V[2][0], V[2][1], V[2][2], 0, 0, 0, 0, 1]; }
                function setIbmQ(jx, Q) {
                    ibmQ[jx] = Q;
                    let o = jx * 16, r, c;
                    for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) ibmFlat[o + c * 4 + r] = Q[r * 4 + c];   // transpose (inverse of a rotation)
                }
                function setShearRest(jx, mat) {
                    const hx = makeHelper(jx), sd = svdDecompose(mat, null), jNode = jointNodeIndices[jx];
                    nodes[hx].translation = sd.translation; nodes[hx].rotation = sd.rotU; nodes[hx].scale = sd.scale;
                    nodes[jNode].rotation = sd.rotV;
                    delete nodes[jNode].translation; delete nodes[jNode].scale;
                }
                const shearJ = {};
                if (hasFrames && paletteRef) {
                    for (let sjn = 0; sjn < jointCount; sjn++) {
                        for (let stk = 0; stk < tracks.length && !shearJ[sjn]; stk++) {
                            const sfr = tracks[stk].frames;
                            for (let sfi = 0; sfi < sfr.length; sfi++) {
                                const sfm = sfr[sfi].meshes[mIdx], spal = sfm && sfm.palette;
                                if (!spal || spal.length < (sjn + 1) * 12) continue;
                                const serr = trsError(jointMat(spal, sjn));
                                if (serr > decErr.max) { decErr.max = serr; decErr.joint = sjn; decErr.frame = sfi; }
                                if (serr > 1e-3) { shearJ[sjn] = true; decErr.bad++; break; }
                            }
                        }
                        if (!shearJ[sjn]) continue;
                        // Constant right rotation? Take V from the first non-uniform frame, then check every frame.
                        let qCand = null, qOk = true, qMax = 0;
                        for (let qt = 0; qt < tracks.length && !qCand; qt++) {
                            const qfr = tracks[qt].frames;
                            for (let qf = 0; qf < qfr.length; qf++) {
                                const qfm = qfr[qf].meshes[mIdx], qpal = qfm && qfm.palette;
                                if (!qpal || qpal.length < (sjn + 1) * 12) continue;
                                const qsd = svdDecompose(jointMat(qpal, sjn), null);
                                if (!qsd.uniform) { qCand = q4FromV(qsd.V); break; }
                            }
                        }
                        if (!qCand) continue;
                        for (let qt2 = 0; qt2 < tracks.length && qOk; qt2++) {
                            const qfr2 = tracks[qt2].frames;
                            for (let qf2 = 0; qf2 < qfr2.length; qf2++) {
                                const qfm2 = qfr2[qf2].meshes[mIdx], qpal2 = qfm2 && qfm2.palette;
                                if (!qpal2 || qpal2.length < (sjn + 1) * 12) continue;
                                const qe = trsError(mulMat4(jointMat(qpal2, sjn), qCand));
                                if (qe > qMax) qMax = qe;
                                if (qe > 1e-3) { qOk = false; break; }
                            }
                        }
                        if (qOk) { setIbmQ(sjn, qCand); shearJ[sjn] = false; ibmFixed++; }
                    }
                }
                if (hasFrames && paletteRef) {
                    let animatedCount = 0;
                    const animatedJoints = {};
                    // Does this joint's TRS vary across the clip's own frames? (compared to the clip's FIRST frame,
                    // so slow drift is caught)
                    const jointClipMoves = (jx, cx) => {
                        let frC = tracks[cx].frames, prev = null;
                        for (let fj = 0; fj < frC.length; fj++) {
                            const fmeshJ = frC[fj].meshes[mIdx];
                            const palJ = fmeshJ && fmeshJ.palette;
                            const mJ = (palJ && palJ.length >= (jx + 1) * 12)
                                   ? jointMat(palJ, jx) : identityMat4();
                            if (prev !== null) {
                                for (let vv = 0; vv < 16; vv++) {
                                    if (Math.abs(mJ[vv] - prev[vv]) > 1e-5 * Math.max(1, Math.abs(prev[vv]))) return true;
                                }
                            } else prev = mJ;
                        }
                        return false;
                    };
                    // Rest pose palette, chosen as in the rest pose code below (without its log lines).
                    const smE = window.staticPoseSnapshot && window.staticPoseSnapshot.meshes[mIdx];
                    const restPalE = (CONFIG.REST_POSE_SOURCE === 'static' && smE && smE.palette &&
                                    smE.palette.length >= paletteRef.palette.length) ? smE.palette : paletteRef.palette;
                    // A joint that does not move in a clip but is held away from the rest pose needs a constant
                    // pose in that clip. Without it, a glTF player shows the rest pose for that joint.
                    const jointDiffersFromRest = (jx, cx) => {
                        const f0 = tracks[cx].frames[0].meshes[mIdx], p0 = f0 && f0.palette;
                        if (!p0 || p0.length < (jx + 1) * 12 || restPalE.length < (jx + 1) * 12) return false;
                        const a = jointMat(p0, jx), b = jointMat(restPalE, jx);
                        for (let dv = 0; dv < 16; dv++) {
                            if (Math.abs(a[dv] - b[dv]) > 1e-5 * Math.max(1, Math.abs(b[dv]))) return true;
                        }
                        return false;
                    };
                    // Still clip: no joint of this skeleton moves in it. Keep still clips: every joint gets a pose
                    // (2 equal keys). Otherwise the clip gets no skeleton channels.
                    let stillClip = [], nStill = 0;
                    for (let sc = 0; sc < tracks.length; sc++) {
                        let scMoves = false;
                        for (let sjx = 0; sjx < jointCount && !scMoves; sjx++) scMoves = jointClipMoves(sjx, sc);
                        stillClip[sc] = !scMoves;
                        if (!scMoves) nStill++;
                    }
                    if (nStill && CONFIG.KEEP_STILL_CLIPS) log(`skin ${skinIdx}: keeping ${nStill} still clip(s) as pose clips`);
                    let holdPoses = 0;
                    for (let jn = 0; jn < jointCount; jn++) {
                        // Per-clip motion test: clips where this joint varies get its keys. A clip where it does
                        // not vary gets a constant pose only when that pose is not the rest pose.
                        const clipHasMotion = [], clipNeeds = [];
                        let anyMotion = false, anyNeed = false;
                        for (let cj = 0; cj < tracks.length; cj++) {
                            clipHasMotion[cj] = jointClipMoves(jn, cj);
                            if (clipHasMotion[cj]) { anyMotion = true; tracks[cj].moving = true; }
                            clipNeeds[cj] = clipHasMotion[cj] ||
                                (stillClip[cj] ? !!CONFIG.KEEP_STILL_CLIPS : jointDiffersFromRest(jn, cj));
                            if (clipNeeds[cj]) anyNeed = true;
                        }
                        if (!anyNeed) continue;
                        if (anyMotion) animatedCount++;
                        const nIdx = jointNodeIndices[jn];
                        animatedJoints[nIdx] = true;

                        for (let ci = 0; ci < tracks.length; ci++) {
                            if (!clipNeeds[ci]) continue;
                            const poseOnly = !clipHasMotion[ci];   // one pose from the clip's first frame
                            if (poseOnly && !stillClip[ci]) holdPoses++;
                            const tr = tracks[ci];
                            const useN = poseOnly ? 1 : tr.frames.length;
                            let T = [], R = [], S = [], RV = [];
                            let prevQ = null, prevQV = null, prevV = null;   // hemisphere fix resets per clip, per joint
                            const tgtTRS = shearJ[jn] ? makeHelper(jn) : nIdx;   // sheared joint: T/R/S go on the helper
                            let svdSeq = null;
                            if (shearJ[jn]) {
                                const smats = [];
                                for (let sfx = 0; sfx < useN; sfx++) {
                                    const sfmx = tr.frames[sfx].meshes[mIdx], spx = sfmx && sfmx.palette;
                                    smats.push((spx && spx.length >= (jn + 1) * 12) ? jointMat(spx, jn) : identityMat4());
                                }
                                svdSeq = svdSequence(smats);
                            }
                            for (let fi3 = 0; fi3 < useN; fi3++) {
                                const fmesh = tr.frames[fi3].meshes[mIdx];
                                const pal = fmesh && fmesh.palette;
                                let mPal = (pal && pal.length >= (jn + 1) * 12)
                                         ? jointMat(pal, jn) : identityMat4();
                                if (ibmQ[jn]) mPal = mulMat4(mPal, ibmQ[jn]);
                                if (shearJ[jn]) {
                                    const sd3 = svdSeq[fi3];
                                    const qU = _quatCont(sd3.rotU, prevQ), qV = _quatCont(sd3.rotV, prevQV);
                                    prevQ = qU; prevQV = qV;
                                    T.push(sd3.translation[0], sd3.translation[1], sd3.translation[2]);
                                    R.push(qU[0], qU[1], qU[2], qU[3]);
                                    S.push(sd3.scale[0], sd3.scale[1], sd3.scale[2]);
                                    RV.push(qV[0], qV[1], qV[2], qV[3]);
                                    continue;
                                }
                                const d = decomposeMat4(mPal);
                                if (prevQ) {
                                    const dot = d.rotation[0]*prevQ[0] + d.rotation[1]*prevQ[1]
                                            + d.rotation[2]*prevQ[2] + d.rotation[3]*prevQ[3];
                                    if (dot < 0) {
                                        d.rotation[0] = -d.rotation[0];
                                        d.rotation[1] = -d.rotation[1];
                                        d.rotation[2] = -d.rotation[2];
                                        d.rotation[3] = -d.rotation[3];
                                    }
                                }
                                prevQ = d.rotation.slice();
                                T.push(d.translation[0], d.translation[1], d.translation[2]);
                                R.push(d.rotation[0], d.rotation[1], d.rotation[2], d.rotation[3]);
                                S.push(d.scale[0], d.scale[1], d.scale[2]);
                            }

                            // Show/hide by scale (scale jumps between ~0 and visible from one sample to the next): the
                            // viewer switches instantly, LINEAR would blend both shapes between the two samples. Hold the old
                            // value until just before the next sample so the switch stays near-instant.
                            let jTimes = tr.times, jTimeFn = ((t0) => () => t0.timeAcc)(tr);
                            if (poseOnly) {
                                // two equal keys, at the start and the end of the clip, so the clip keeps its length
                                T = T.concat(T); R = R.concat(R); S = S.concat(S); if (RV.length) RV = RV.concat(RV);
                                jTimes = [tr.times[0], tr.times[tr.times.length - 1]];
                                jTimeFn = lazyTimeAcc(jTimes);
                            }
                            (() => {
                                if (poseOnly) return;
                                let nF = jTimes.length, mags = [], mxs = 0, hi, hk;
                                for (hi = 0; hi < nF; hi++) {
                                    const mg = Math.max(Math.abs(S[hi * 3]), Math.abs(S[hi * 3 + 1]), Math.abs(S[hi * 3 + 2]));
                                    mags.push(mg); if (mg > mxs) mxs = mg;
                                }
                                if (!(mxs > 0)) return;
                                const lo = 1e-4 * mxs, vis = 0.1 * mxs, cuts = [];
                                for (hi = 0; hi + 1 < nF; hi++) {
                                    const a0 = mags[hi], a1 = mags[hi + 1];
                                    if ((a0 <= lo && a1 >= vis) || (a1 <= lo && a0 >= vis)) cuts.push(hi);
                                }
                                if (!cuts.length) return;
                                let nt = [], nT = [], nR = [], nS = [], nRV = [], ci3 = 0;
                                function pushF(src, t) {
                                    nt.push(t);
                                    for (hk = 0; hk < 3; hk++) { nT.push(T[src * 3 + hk]); nS.push(S[src * 3 + hk]); }
                                    for (hk = 0; hk < 4; hk++) { nR.push(R[src * 4 + hk]); if (RV.length) nRV.push(RV[src * 4 + hk]); }
                                }
                                for (hi = 0; hi < nF; hi++) {
                                    pushF(hi, jTimes[hi]);
                                    if (ci3 < cuts.length && cuts[ci3] === hi) {
                                        const gap = jTimes[hi + 1] - jTimes[hi];
                                        if (gap > 2e-4) pushF(hi, Math.fround(jTimes[hi + 1] - Math.min(0.001, gap * 0.5)));
                                        ci3++;
                                    }
                                }
                                T = nT; R = nR; S = nS; if (RV.length) RV = nRV;
                                jTimes = nt;
                                jTimeFn = lazyTimeAcc(nt);
                                holdJoints++;
                            })();

                            const tolJ = 1e-5 * (sceneSizeLocal || 1);
                            emitSampler(tr, jTimes, jTimeFn, T, 3, 'VEC3', tgtTRS, 'translation', tolJ);
                            emitSampler(tr, jTimes, jTimeFn, R, 4, 'VEC4', tgtTRS, 'rotation', tolJ);
                            emitSampler(tr, jTimes, jTimeFn, S, 3, 'VEC3', tgtTRS, 'scale', tolJ);
                            if (shearJ[jn]) emitSampler(tr, jTimes, jTimeFn, RV, 4, 'VEC4', nIdx, 'rotation', tolJ);
                        }
                    }

                    // Give every joint its rest-pose TRS as the node default.
                    // Animation channels override this where present. Without
                    // it, a joint that has animation would collapse to identity
                    // (origin) when no animation is playing.
                    // Rest pose source: the first frame of the first clip, or the viewer's
                    // Static Pose snapshot (REST_POSE_SOURCE). Static falls back to the clip
                    // frame when no usable snapshot exists (e.g. single-clip RECORD).
                    let restPal = paletteRef.palette;
                    const sm = window.staticPoseSnapshot && window.staticPoseSnapshot.meshes[mIdx];
                    const staticOk = !!(sm && sm.palette && sm.palette.length >= paletteRef.palette.length);
                    if (staticOk) {
                        let diffJ = 0;
                        for (let dj = 0; dj < jointCount; dj++) {
                            for (let dk = 0; dk < 12; dk++) {
                                const di = dj * 12 + dk;
                                if (di >= paletteRef.palette.length) break;
                                if (Math.abs(sm.palette[di] - paletteRef.palette[di]) > 1e-4) { diffJ++; break; }
                            }
                        }
                        log('rest pose: mesh ' + mIdx + ' Static Pose vs clip frame 0 differ on ' +
                            diffJ + '/' + jointCount + ' joints');
                    }
                    if (CONFIG.REST_POSE_SOURCE === 'static') {
                        if (staticOk) restPal = sm.palette;
                        else if (!staticWarned) {
                            staticWarned = true;   // once per export, not once per mesh
                            warn('rest pose: Static Pose snapshot unavailable (run RECORD ALL CLIPS first); using clip frame 0');
                        }
                    }
                    log('rest pose source: ' + (restPal === paletteRef.palette ? 'clip frame 0' : 'Static Pose') +
                        ' (mesh ' + mIdx + ')');
                    let restSkipped = 0;
                    for (let sj = 0; sj < jointCount; sj++) {
                        const jnIdx = jointNodeIndices[sj];
                        if ((sj + 1) * 12 > restPal.length || jnIdx === undefined) {
                            restSkipped++;   // palette shorter than the joint list: leave node default
                            continue;
                        }
                        let pal0 = jointMat(restPal, sj);
                        if (ibmQ[sj]) pal0 = mulMat4(pal0, ibmQ[sj]);
                        else if (!shearJ[sj] && !animatedJoints[jnIdx] && trsError(pal0) > 1e-3) {
                            setIbmQ(sj, q4FromV(svdDecompose(pal0, null).V)); ibmFixed++;   // static joint: P*Q is exact TRS
                            pal0 = mulMat4(pal0, ibmQ[sj]);
                        }
                        if (shearJ[sj]) { setShearRest(sj, pal0); continue; }
                        const d0 = decomposeMat4(pal0);
                        nodes[jnIdx].translation = d0.translation;
                        nodes[jnIdx].rotation = d0.rotation;
                        nodes[jnIdx].scale = d0.scale;
                    }

                    if (restSkipped) warn('skin', skinIdx, ': rest pose skipped for', restSkipped, 'joint(s), palette too short');
                    log('skin', skinIdx, 'for mesh', meshes[nodes[meshNodeIdx].mesh].name,
                        '→', jointCount, 'joints,', animatedCount, 'animated,',
                        tracks.length, 'clip(s)');
                    if (holdPoses) log(`skin ${skinIdx}: ${holdPoses} joint pose(s) held in clips where the joint does not move but is away from the rest pose`);
                    if (holdJoints) log(`skin ${skinIdx}: ${holdJoints} joint channel set(s) with show/hide-by-scale switches kept instant (hold keys)`);
                    if (ibmFixed) log(`skin ${skinIdx}: ${ibmFixed} sheared joint(s) stored exactly via the inverse bind matrix (plain TRS joints)`);
                    let nHelp = 0; for (let hk in helperOf) if (helperOf.hasOwnProperty(hk)) nHelp++;
                    if (nHelp) log('skin ' + skinIdx + ': ' + nHelp + ' joint(s) with shear (max ' + (decErr.max * 100).toFixed(1) +
                        '% TRS error at joint ' + decErr.joint + ') stored exactly as helper node + joint (U*S*Vt)');
                } else {
                    const live = liveSnap && liveSnap[mIdx];
                    if (live && live.palette) {
                        for (let sj2 = 0; sj2 < jointCount; sj2++) {
                            if ((sj2 + 1) * 12 > live.palette.length) break;
                            let lm = jointMat(live.palette, sj2);
                            if (trsError(lm) > 1e-3) { setIbmQ(sj2, q4FromV(svdDecompose(lm, null).V)); lm = mulMat4(lm, ibmQ[sj2]); ibmFixed++; }
                            const dl = decomposeMat4(lm);
                            const jn2 = jointNodeIndices[sj2];
                            nodes[jn2].translation = dl.translation;
                            nodes[jn2].rotation = dl.rotation;
                            nodes[jn2].scale = dl.scale;
                        }
                    }
                    log('skin', skinIdx, 'static from live palette, joints:', jointCount);
                }
            });

            // ---- animation of UNSKINNED meshes: node motion and morph weights ----
            // Skinned meshes animate through their palette (above). A mesh that has no
            // skin can still move (its node chain is animated) and/or morph (weights).
            function emitNodeTRS(tr, nIdx, matAt) {
                let T = [], R = [], S = [], prevQ = null;
                for (let fi4 = 0; fi4 < tr.frames.length; fi4++) {
                    const d4 = decomposeMat4(matAt(fi4));
                    if (prevQ) {
                        const dot4 = d4.rotation[0]*prevQ[0] + d4.rotation[1]*prevQ[1]
                                 + d4.rotation[2]*prevQ[2] + d4.rotation[3]*prevQ[3];
                        if (dot4 < 0) {
                            d4.rotation[0] = -d4.rotation[0]; d4.rotation[1] = -d4.rotation[1];
                            d4.rotation[2] = -d4.rotation[2]; d4.rotation[3] = -d4.rotation[3];
                        }
                    }
                    prevQ = d4.rotation.slice();
                    T.push(d4.translation[0], d4.translation[1], d4.translation[2]);
                    R.push(d4.rotation[0], d4.rotation[1], d4.rotation[2], d4.rotation[3]);
                    S.push(d4.scale[0], d4.scale[1], d4.scale[2]);
                }
                const tolN = 1e-5 * (sceneSizeWorld || 1);
                const trFn = () => tr.timeAcc;
                emitSampler(tr, tr.times, trFn, T, 3, 'VEC3', nIdx, 'translation', tolN);
                emitSampler(tr, tr.times, trFn, R, 4, 'VEC4', nIdx, 'rotation', tolN);
                emitSampler(tr, tr.times, trFn, S, 3, 'VEC3', nIdx, 'scale', tolN);
            }

            if (hasFrames) {
                allNodes.forEach((obj, mIdx) => {
                    const nodeIdx = nodeMap.get(obj);
                    if (nodeIdx === undefined || nodes[nodeIdx].mesh === undefined) return;

                    // node motion: the recorded world matrix changes within a clip
                    if (!meshHasSkinning[mIdx]) {
                        let moves = [], anyMove = false;
                        tracks.forEach((trk, ti) => {
                            let f0 = trk.frames[0].meshes[mIdx], w0 = f0 && f0.world, moved = false;
                            for (let fm2 = 1; w0 && fm2 < trk.frames.length && !moved; fm2++) {
                                const fw = trk.frames[fm2].meshes[mIdx], wn = fw && fw.world;
                                if (!wn) continue;
                                for (let wv = 0; wv < 16; wv++) {
                                    if (Math.abs(wn[wv] - w0[wv]) > 1e-5 * Math.max(1, Math.abs(w0[wv]))) { moved = true; break; }
                                }
                            }
                            moves[ti] = moved;
                            if (moved) anyMove = true;
                        });
                        if (anyMove) {
                            const r0m = tracks[0].frames[0].meshes[mIdx];
                            const rest0 = (r0m && r0m.world) ? r0m.world : computeWorldMatrix(obj);
                            const dRest = decomposeMat4(rest0);
                            delete nodes[nodeIdx].matrix;
                            nodes[nodeIdx].translation = dRest.translation;
                            nodes[nodeIdx].rotation = dRest.rotation;
                            nodes[nodeIdx].scale = dRest.scale;
                            tracks.forEach((trk, ti) => {
                                if (moves[ti]) trk.moving = true;
                            });
                            let nodeHolds = 0;
                            tracks.forEach((trk, ti) => {
                                if (!moves[ti]) {
                                    // Still in this clip: hold its pose if that is not the rest pose (and the clip moves).
                                    let h0 = trk.frames[0].meshes[mIdx], hw = h0 && h0.world, away = false;
                                    for (let hv = 0; hw && hv < 16 && !away; hv++) {
                                        if (Math.abs(hw[hv] - rest0[hv]) > 1e-5 * Math.max(1, Math.abs(rest0[hv]))) away = true;
                                    }
                                    if (!away || !(trk.moving || CONFIG.KEEP_STILL_CLIPS)) return;
                                    nodeHolds++;
                                }
                                emitNodeTRS(trk, nodeIdx, (f) => {
                                    const fx = trk.frames[f].meshes[mIdx];
                                    return (fx && fx.world) || rest0;
                                });
                            });
                            log('node animation: ' + nodes[nodeIdx].name + ' moves in ' +
                                moves.filter((x) => x).length + ' clip(s)' +
                                (nodeHolds ? `, pose held in ${nodeHolds} clip(s)` : ''));
                        }
                    }

                    // morph weights
                    const mi2 = morphInfo[mIdx];
                    if (mi2) {
                        const wRest = tracks[0].frames[0].meshes[mIdx];
                        const wr = (wRest && wRest.weights) || null;
                        if (wr) {
                            const restW = [];
                            for (let rw = 0; rw < mi2.n; rw++) restW.push(wr[rw] || 0);
                            meshes[mi2.meshIdx].weights = restW;
                        }
                        tracks.forEach((trk) => {
                            let base = trk.frames[0].meshes[mIdx], bw = base && base.weights, varies = false;
                            if (!bw) return;
                            let restOff = false;   // constant in this clip, but not the rest weights
                            if (wr) for (let rk = 0; rk < mi2.n && !restOff; rk++) {
                                if (Math.abs((bw[rk] || 0) - (wr[rk] || 0)) > 1e-4) restOff = true;
                            }
                            for (let fw2 = 1; fw2 < trk.frames.length && !varies; fw2++) {
                                const ww = trk.frames[fw2].meshes[mIdx];
                                const wv2 = ww && ww.weights;
                                if (!wv2) continue;
                                for (let kk = 0; kk < mi2.n; kk++) {
                                    if (Math.abs((wv2[kk] || 0) - (bw[kk] || 0)) > 1e-4) { varies = true; break; }
                                }
                            }
                            if (varies) trk.moving = true;
                            else if (!restOff || !(trk.moving || CONFIG.KEEP_STILL_CLIPS)) return;
                            const out = new Float32Array(trk.frames.length * mi2.n);
                            for (let fw3 = 0; fw3 < trk.frames.length; fw3++) {
                                const wm = trk.frames[fw3].meshes[mIdx], wa = (wm && wm.weights) || bw;
                                for (let kw = 0; kw < mi2.n; kw++) out[fw3 * mi2.n + kw] = wa[kw] || 0;
                            }
                            const aWt = accs.length;
                            accs.push({ bufferView: addBV(out), componentType: 5126,
                                        count: out.length, type: 'SCALAR' });
                            trk.samplers.push({ input: trk.timeAcc, interpolation: 'LINEAR', output: aWt });
                            trk.channels.push({ sampler: trk.samplers.length - 1,
                                                target: { node: nodeIdx, path: 'weights' } });
                            log(`morph animation: ${nodes[nodeIdx].name} (${mi2.n} target(s))${varies ? '' : ', weights held'}`);
                        });
                    }
                });
            }

            if (tracks.length) {
                const animList = [];
                const noMotion = [];
                tracks.forEach((tr) => {
                    if (tr.channels.length) {
                        animList.push({ name: tr.name, samplers: tr.samplers, channels: tr.channels });
                        log('animation "' + tr.name + '": ' + tr.channels.length + ' channels, '
                            + tr.times.length + ' frames');
                    } else {
                        noMotion.push(tr.name);
                    }
                });
                if (noMotion.length) log(`clips without motion, not exported (${noMotion.length}): ${noMotion.join(', ')}`);
                if (keyStats.before) log('keyframes reduced: ' + keyStats.before + ' -> ' + keyStats.after + ' (' +
                    Math.round(100 * keyStats.after / keyStats.before) + '% kept, translation tolerance ' + (1e-5 * (sceneSizeLocal || 1)).toPrecision(2) + ')');
                if (animList.length) animations = animList;
            }

            // Scene root with YUP
            let sceneRootIdx = nodes.length;
            const rootMat = YUP.slice();
            const expScale = (typeof CONFIG.EXPORT_SCALE === 'number' && CONFIG.EXPORT_SCALE > 0) ? CONFIG.EXPORT_SCALE : 1;
            if (expScale !== 1) {
                [0, 1, 2, 4, 5, 6, 8, 9, 10].forEach((ix) => { rootMat[ix] *= expScale; });
                log('export scale', expScale);
            }
            nodes.push({ name: 'scene_root', matrix: rootMat, children: [] });

            const naturalRoots = [];
            nodes.forEach((n, i) => {
                if (i === sceneRootIdx || skippedNodes[i]) return;
                let hasP = false;
                for (let j = 0; j < nodes.length; j++) {
                    if (nodes[j].children && nodes[j].children.indexOf(i) !== -1) { hasP = true; break; }
                }
                if (!hasP) naturalRoots.push(i);
            });
            naturalRoots.forEach((r) => {
                nodes[sceneRootIdx].children.push(r);
            });
            if (Object.keys(skippedNodes).length) {
                sceneRootIdx = removeNodes(nodes, gltfSkins, animations, skippedNodes, sceneRootIdx);
            }

            nodes.forEach((n, ni) => {
                if (ni === sceneRootIdx || !n.matrix) return;
                let idm = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], same = n.matrix.length === 16;
                for (let im = 0; same && im < 16; im++) if (Math.abs(n.matrix[im] - idm[im]) > 1e-9) same = false;
                if (same) delete n.matrix;   // validator NODE_MATRIX_DEFAULT
            });

            const rootNodes = [sceneRootIdx];
            nodes.forEach((n) => {
                if (n.children && n.children.length === 0) delete n.children;
            });

            const gltf = {
                asset: { version: '2.0' },
                scene: 0,
                scenes: [{ nodes: rootNodes }],
                nodes,
                meshes,
                accessors: accs,
                bufferViews: bvs,
                materials: mats,
                buffers: [{ byteLength: off }]
            };
            // Drop textures no material references (captured env/matcap/leftover images) and remap indices.
            const texUsed = {}, texNew = {}, keptImages = [], keptTextures = [], zipTex = {};
            function markTex(o) { if (o && typeof o.index === 'number') texUsed[o.index] = true; }
            mats.forEach((m) => {
                const pb = m.pbrMetallicRoughness || {};
                markTex(pb.baseColorTexture); markTex(pb.metallicRoughnessTexture);
                markTex(m.normalTexture); markTex(m.occlusionTexture); markTex(m.emissiveTexture);
            });
            for (let ti2 = 0; ti2 < textures.length; ti2++) {
                if (!texUsed[ti2]) continue;
                texNew[ti2] = keptTextures.length;
                keptImages.push({ uri: images[textures[ti2].source].uri });
                keptTextures.push({ source: keptImages.length - 1 });
                zipTex[imageKeys[textures[ti2].source].key] = imageKeys[textures[ti2].source].safe;
            }
            function remapTex(o) { if (o && typeof o.index === 'number') o.index = texNew[o.index]; }
            mats.forEach((m) => {
                const pb = m.pbrMetallicRoughness || {};
                remapTex(pb.baseColorTexture); remapTex(pb.metallicRoughnessTexture);
                remapTex(m.normalTexture); remapTex(m.occlusionTexture); remapTex(m.emissiveTexture);
            });
            if (keptTextures.length !== textures.length) log(`textures: ${keptTextures.length} used, ${textures.length - keptTextures.length} unused dropped`);
            images = keptImages; textures = keptTextures;
            // glTF forbids empty arrays (validator: EMPTY_ENTITY), so texture-less models omit these.
            if (images.length) gltf.images = images;
            if (textures.length) gltf.textures = textures;
            if (gltfSkins.length) gltf.skins = gltfSkins;
            if (animations) gltf.animations = animations;

            log(`built scene: nodes=${nodes.length}`,
                `meshes=${meshes.length}`,
                `skins=${gltfSkins.length}`,
                `animClips=${animations ? animations.length : 0}`,
                `animFrames=${animations ? tracks[0].times.length : 0}`);

            const jsonStr = JSON.stringify(gltf);
            const jsonBytes = new TextEncoder().encode(jsonStr);
            const jAl = pad(jsonBytes.byteLength), jPad = jAl - jsonBytes.byteLength;
            let binAll = new Uint8Array(off), binPos = 0;
            for (let bc = 0; bc < binChunks.length; bc++) {
                binAll.set(binChunks[bc], binPos);
                binPos += binChunks[bc].length;
            }
            const bin = binAll.buffer;
            const bAl = pad(bin.byteLength), bPad = bAl - bin.byteLength;
            const total = 12 + 8 + jAl + 8 + bAl;

            const glb = new ArrayBuffer(total);
            let dv = new DataView(glb), o = 0;
            dv.setUint32(o, 0x46546C67, true); o += 4;
            dv.setUint32(o, 2, true); o += 4;
            dv.setUint32(o, total, true); o += 4;
            dv.setUint32(o, jAl, true); o += 4;
            dv.setUint32(o, 0x4E4F534A, true); o += 4;
            new Uint8Array(glb, o, jsonBytes.length).set(jsonBytes); o += jsonBytes.length;
            for (let k1 = 0; k1 < jPad; k1++) new Uint8Array(glb, o + k1, 1)[0] = 0x20;
            o += jPad;
            dv.setUint32(o, bAl, true); o += 4;
            dv.setUint32(o, 0x004E4942, true); o += 4;
            new Uint8Array(glb, o, bin.byteLength).set(new Uint8Array(bin)); o += bin.byteLength;
            for (let k2 = 0; k2 < bPad; k2++) new Uint8Array(glb, o + k2, 1)[0] = 0;

            const ml2 = document.getElementsByClassName('model-name__label')[0];
            const modelName = (ml2 ? ml2.textContent.trim().replace(/\.+$/, '') : 'model').replace(/[\\\/:*?"<>|]/g, '_') || 'model';
            return { glb, gltf, bin: binAll, zipTex, modelName };
        } catch (e) {
            e.message = 'scene build failed: ' + e.message;
            throw e;
        }
    }

    // ====================================================================
    // FBX export: binary FBX 7.4 written from the finished glTF
    // (same scene as the GLB: nodes, meshes, materials, skins, clips, morphs)
    // ====================================================================
    // gltfToFbx(gltf, bin, opts) -> { fbx: ArrayBuffer, splits: [...], stats }
    //   gltf : glTF JSON object (as written into the GLB)
    //   bin  : Uint8Array, the GLB binary chunk
    //   opts : { creator, fps, onProgress(fraction, label) }
    // splits: textures that FBX needs as separate files (glTF packs roughness
    //   in G and metalness in B of one image). The caller writes them:
    //   { src: <image uri>, channel: 'G'|'B', out: <new uri> }
    const FbxWriter = (function () {
        'use strict';
        const KTIME = 46186158000;          // FBX ticks per second
        const ALWAYS_SENTINEL = { AnimationStack: 1, AnimationLayer: 1 };

        // ---------------- property constructors ----------------
        const P = {
            I: (v) => ({ t: 'I', v }), L: (v) => ({ t: 'L', v }), D: (v) => ({ t: 'D', v }),
            F: (v) => ({ t: 'F', v }), C: (v) => ({ t: 'C', v }), Y: (v) => ({ t: 'Y', v }),
            S: (v) => ({ t: 'S', v }), R: (v) => ({ t: 'R', v }),
            d: (a) => ({ t: 'd', v: a instanceof Float64Array ? a : Float64Array.from(a) }),
            f: (a) => ({ t: 'f', v: a instanceof Float32Array ? a : Float32Array.from(a) }),
            i: (a) => ({ t: 'i', v: a instanceof Int32Array ? a : Int32Array.from(a) }),
            l: (a) => ({ t: 'l', v: a }),   // array of numbers (int64)
        };
        function node(name, props, children) { return { name, props: props || [], children: children || [] }; }
        const enc = new TextEncoder();
        function strBytes(s) { return typeof s === 'string' ? enc.encode(s) : s; }
        function objName(name, cls) {     // "Name\x00\x01Class"
            const a = enc.encode(name || ''), b = enc.encode(cls);
            const out = new Uint8Array(a.length + 2 + b.length);
            out.set(a, 0); out[a.length] = 0; out[a.length + 1] = 1; out.set(b, a.length + 2);
            return out;
        }

        // ---------------- binary encoder (two passes: size, then write) ----------------
        function propSize(p) {
            switch (p.t) {
                case 'Y': return 3; case 'C': return 2; case 'I': case 'F': return 5;
                case 'D': case 'L': return 9;
                case 'S': case 'R': p._b = strBytes(p.v); return 5 + p._b.length;
                case 'd': case 'l': return 13 + (p.z ? p.z.length : p.v.length * 8);
                case 'f': case 'i': return 13 + (p.z ? p.z.length : p.v.length * 4);
            }
            throw new Error('FBX: bad property type ' + p.t);
        }
        function nodeSize(n) {
            n._nb = enc.encode(n.name);
            let ps = 0; for (const p of n.props) ps += propSize(p);
            n._ps = ps;
            let s = 13 + n._nb.length + ps;
            if (n.children.length || ALWAYS_SENTINEL[n.name]) {
                for (const c of n.children) s += nodeSize(c);
                s += 13;
            }
            n._size = s;
            return s;
        }
        function writeNodes(roots, version, creatorTime) {
            const head = enc.encode('Kaydara FBX Binary  ');
            let total = head.length + 3 + 4;
            for (const r of roots) total += nodeSize(r);
            total += 13;                                  // end of top-level list
            const footLen = 16 + 4 + 16 + 4 + 120 + 16;   // worst case padding 16
            const buf = new ArrayBuffer(total + footLen);
            const dv = new DataView(buf), u8 = new Uint8Array(buf);
            let o = 0;
            u8.set(head, 0); o = head.length;
            u8[o++] = 0; u8[o++] = 0x1A; u8[o++] = 0;
            dv.setUint32(o, version, true); o += 4;
            function wProp(p) {
                u8[o++] = p.t.charCodeAt(0);
                switch (p.t) {
                    case 'Y': dv.setInt16(o, p.v, true); o += 2; break;
                    case 'C': u8[o++] = p.v ? 1 : 0; break;
                    case 'I': dv.setInt32(o, p.v, true); o += 4; break;
                    case 'F': dv.setFloat32(o, p.v, true); o += 4; break;
                    case 'D': dv.setFloat64(o, p.v, true); o += 8; break;
                    case 'L': dv.setBigInt64(o, BigInt(Math.round(p.v)), true); o += 8; break;
                    case 'S': case 'R': dv.setUint32(o, p._b.length, true); o += 4; u8.set(p._b, o); o += p._b.length; break;
                    default: {
                        const n = p.v.length, w = (p.t === 'd' || p.t === 'l') ? 8 : 4;
                        if (p.z) {   // zlib-compressed array (encoding 1)
                            dv.setUint32(o, n, true); dv.setUint32(o + 4, 1, true); dv.setUint32(o + 8, p.z.length, true); o += 12;
                            u8.set(p.z, o); o += p.z.length;
                            break;
                        }
                        dv.setUint32(o, n, true); dv.setUint32(o + 4, 0, true); dv.setUint32(o + 8, n * w, true); o += 12;
                        if (p.t === 'd') { for (let k = 0; k < n; k++, o += 8) dv.setFloat64(o, p.v[k], true); }
                        else if (p.t === 'f') { for (let k = 0; k < n; k++, o += 4) dv.setFloat32(o, p.v[k], true); }
                        else if (p.t === 'i') { for (let k = 0; k < n; k++, o += 4) dv.setInt32(o, p.v[k], true); }
                        else { for (let k = 0; k < n; k++, o += 8) dv.setBigInt64(o, BigInt(Math.round(p.v[k])), true); }
                    }
                }
            }
            function wNode(n) {
                const start = o;
                dv.setUint32(o, start + n._size, true);
                dv.setUint32(o + 4, n.props.length, true);
                dv.setUint32(o + 8, n._ps, true);
                u8[o + 12] = n._nb.length; o += 13;
                u8.set(n._nb, o); o += n._nb.length;
                for (const p of n.props) wProp(p);
                if (n.children.length || ALWAYS_SENTINEL[n.name]) {
                    for (const c of n.children) wNode(c);
                    o += 13;                               // null record (already zero)
                }
                if (o !== start + n._size) throw new Error('FBX: size mismatch in ' + n.name);
            }
            for (const r of roots) wNode(r);
            o += 13;
            // footer (same layout as files from the FBX SDK)
            u8.set([0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e], o); o += 16;
            o += 4;
            let pad = ((o + 15) & ~15) - o; if (pad === 0) pad = 16;
            o += pad;
            dv.setUint32(o, version, true); o += 4;
            o += 120;
            u8.set([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b], o); o += 16;
            return buf.slice(0, o);
        }

        // raw little-endian bytes of an array property
        function arrayBytes(p) {
            let ta;
            if (p.t === 'd') ta = p.v instanceof Float64Array ? p.v : Float64Array.from(p.v);
            else if (p.t === 'f') ta = p.v instanceof Float32Array ? p.v : Float32Array.from(p.v);
            else if (p.t === 'i') ta = p.v instanceof Int32Array ? p.v : Int32Array.from(p.v);
            else { ta = new BigInt64Array(p.v.length); for (let k = 0; k < p.v.length; k++) ta[k] = BigInt(Math.round(p.v[k])); }
            return new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
        }
        // compress big arrays with the caller's zlib deflate (async), like FBX SDK files
        async function compressArrays(roots, deflate, prog) {
            const list = [];
            (function walk(n) { for (const p of n.props) if ('dfil'.includes(p.t) && p.t.length === 1 && p.v.length * (p.t === 'd' || p.t === 'l' ? 8 : 4) >= 1024) list.push(p); n.children.forEach(walk); })({ props: [], children: roots });
            let total = 0; list.forEach((p) => { total += p.v.length; });
            let done = 0;
            for (const p of list) {
                const raw = arrayBytes(p);
                const z = await deflate(raw);
                if (z && z.length < raw.length) p.z = z;
                done += p.v.length;
                prog(done / Math.max(1, total));
            }
            return list.length;
        }

        // ---------------- Properties70 helper ----------------
        function P70(list) {
            return node('Properties70', [], list.map((e) => {
                const [name, t1, t2, flags, ...vals] = e;
                const props = [P.S(name), P.S(t1), P.S(t2), P.S(flags)];
                for (const v of vals) {
                    if (typeof v === 'string') props.push(P.S(v));
                    else if (t1 === 'KTime') props.push(P.L(v));
                    else if (t1 === 'int' || t1 === 'enum' || t1 === 'bool' || t1 === 'Integer') props.push(P.I(v | 0));
                    else props.push(P.D(v));
                }
                return node('P', props);
            }));
        }

        // ---------------- math ----------------
        function mul4(a, b) {   // column-major
            const r = new Array(16);
            for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) {
                let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
                r[c * 4 + rr] = s;
            }
            return r;
        }
        function inv4(m) {
            const a = m, inv = new Array(16);
            inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
            inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
            inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
            inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
            inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
            inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
            inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
            inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
            inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
            inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
            inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
            inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
            inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
            inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
            inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
            inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
            let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
            if (!det || !isFinite(det)) return null;
            det = 1 / det;
            for (let k = 0; k < 16; k++) inv[k] *= det;
            return inv;
        }
        function trsMat(t, q, s) {
            const [x, y, z, w] = q;
            const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
            return [
                (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
                2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
                2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
                t[0], t[1], t[2], 1];
        }
        function nodeLocal(n) {
            if (n.matrix) return n.matrix.slice();
            return trsMat(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
        }
        // matrix -> {t, q, s, shear}; negative determinant flips the X scale
        function decompose(m) {
            const t = [m[12], m[13], m[14]];
            let c0 = [m[0], m[1], m[2]], c1 = [m[4], m[5], m[6]], c2 = [m[8], m[9], m[10]];
            const len = (v) => Math.hypot(v[0], v[1], v[2]);
            let sx = len(c0), sy = len(c1), sz = len(c2);
            const det = c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) - c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) + c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);
            if (det < 0) sx = -sx;
            const n = (v, l) => l ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
            c0 = n(c0, sx); c1 = n(c1, sy); c2 = n(c2, sz);
            const shear = Math.abs(c0[0] * c1[0] + c0[1] * c1[1] + c0[2] * c1[2]) + Math.abs(c0[0] * c2[0] + c0[1] * c2[1] + c0[2] * c2[2]) + Math.abs(c1[0] * c2[0] + c1[1] * c2[1] + c1[2] * c2[2]);
            return { t, q: quatFromRot(c0, c1, c2), s: [sx, sy, sz], shear };
        }
        function quatFromRot(c0, c1, c2) {   // columns of a rotation matrix
            const m00 = c0[0], m10 = c0[1], m20 = c0[2], m01 = c1[0], m11 = c1[1], m21 = c1[2], m02 = c2[0], m12 = c2[1], m22 = c2[2];
            const tr = m00 + m11 + m22; let x, y, z, w;
            if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
            else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s; }
            else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s; }
            else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4; }
            const l = Math.hypot(x, y, z, w) || 1;
            return [x / l, y / l, z / l, w / l];
        }
        // quaternion -> FBX Euler XYZ in degrees (R = Rz * Ry * Rx), closest to prev
        const R2D = 180 / Math.PI;
        function quatToEuler(q, prev) {
            const [x, y, z, w] = q;
            const m00 = 1 - 2 * (y * y + z * z), m10 = 2 * (x * y + w * z), m20 = 2 * (x * z - w * y);
            const m21 = 2 * (y * z + w * x), m22 = 1 - 2 * (x * x + y * y);
            const m01 = 2 * (x * y - w * z), m11 = 1 - 2 * (x * x + z * z);
            let ex, ey, ez;
            const sy = -m20;
            if (Math.abs(sy) < 0.9999999) {
                ey = Math.asin(Math.max(-1, Math.min(1, sy)));
                ex = Math.atan2(m21, m22);
                ez = Math.atan2(m10, m00);
            } else {   // gimbal lock: put everything into X
                ey = sy > 0 ? Math.PI / 2 : -Math.PI / 2;
                ez = prev ? prev[2] / R2D : 0;
                ex = Math.atan2(-m01 * (sy > 0 ? 1 : -1), m11) + (sy > 0 ? ez : -ez);
            }
            let e = [ex * R2D, ey * R2D, ez * R2D];
            if (prev) {
                const alt = [e[0] + 180, 180 - e[1], e[2] + 180];
                const wrap = (v, p) => v + 360 * Math.round((p - v) / 360);
                const fit = (c) => c.map((v, i) => wrap(v, prev[i]));
                const a = fit(e), b = fit(alt);
                const da = Math.abs(a[0] - prev[0]) + Math.abs(a[1] - prev[1]) + Math.abs(a[2] - prev[2]);
                const db = Math.abs(b[0] - prev[0]) + Math.abs(b[1] - prev[1]) + Math.abs(b[2] - prev[2]);
                e = da <= db ? a : b;
            }
            return e;
        }
        function eulerToQuat(e) {
            const hx = e[0] / R2D / 2, hy = e[1] / R2D / 2, hz = e[2] / R2D / 2;
            const cx = Math.cos(hx), sx = Math.sin(hx), cy = Math.cos(hy), sy = Math.sin(hy), cz = Math.cos(hz), sz = Math.sin(hz);
            // q = qz * qy * qx
            return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
        }
        function slerp(a, b, u) {
            let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
            let bb = b; if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
            if (d > 0.9995) {
                const r = [a[0] + (bb[0] - a[0]) * u, a[1] + (bb[1] - a[1]) * u, a[2] + (bb[2] - a[2]) * u, a[3] + (bb[3] - a[3]) * u];
                const l = Math.hypot(...r); return r.map((v) => v / l);
            }
            const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - u) * th) / s, wb = Math.sin(u * th) / s;
            return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
        }
        function quatAngle(a, b) {
            const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
            return 2 * Math.acos(Math.min(1, d)) * R2D;
        }

        // ---------------- glTF accessor reader ----------------
        function makeReader(gltf, bin) {
            const dvBin = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
            const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
            const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
            return function read(idx) {
                const a = gltf.accessors[idx];
                const nc = NC[a.type], cs = SIZE[a.componentType], n = a.count;
                const out = new Float64Array(n * nc);
                if (a.bufferView !== undefined) {
                    const bv = gltf.bufferViews[a.bufferView];
                    const stride = bv.byteStride || nc * cs;
                    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
                    for (let e = 0; e < n; e++) for (let c = 0; c < nc; c++) {
                        const p = base + e * stride + c * cs;
                        let v;
                        switch (a.componentType) {
                            case 5126: v = dvBin.getFloat32(p, true); break;
                            case 5121: v = dvBin.getUint8(p); if (a.normalized) v /= 255; break;
                            case 5120: v = dvBin.getInt8(p); if (a.normalized) v = Math.max(v / 127, -1); break;
                            case 5123: v = dvBin.getUint16(p, true); if (a.normalized) v /= 65535; break;
                            case 5122: v = dvBin.getInt16(p, true); if (a.normalized) v = Math.max(v / 32767, -1); break;
                            case 5125: v = dvBin.getUint32(p, true); break;
                        }
                        out[e * nc + c] = v;
                    }
                }
                if (a.sparse) {
                    const si = a.sparse.indices, sv = a.sparse.values, cnt = a.sparse.count;
                    const ib = gltf.bufferViews[si.bufferView], vb = gltf.bufferViews[sv.bufferView];
                    const io = (ib.byteOffset || 0) + (si.byteOffset || 0), vo = (vb.byteOffset || 0) + (sv.byteOffset || 0);
                    for (let k = 0; k < cnt; k++) {
                        const ix = si.componentType === 5125 ? dvBin.getUint32(io + k * 4, true) : si.componentType === 5123 ? dvBin.getUint16(io + k * 2, true) : dvBin.getUint8(io + k);
                        for (let c = 0; c < nc; c++) out[ix * nc + c] = dvBin.getFloat32(vo + (k * nc + c) * 4, true);
                    }
                }
                out.nc = nc;
                return out;
            };
        }

        // ---------------- converter ----------------
        async function gltfToFbx(gltf, bin, opts) {
            opts = opts || {};
            const prog = opts.onProgress || function () {};
            // give the page a chance to repaint the progress bars during long work
            let lastYield = Date.now();
            const yieldUI = () => (Date.now() - lastYield > 40 ? new Promise((r) => setTimeout(() => { lastYield = Date.now(); r(); }, 0)) : null);
            const fps = opts.fps || 30;
            const read = makeReader(gltf, bin);
            const warnings = [];
            const nodes = gltf.nodes || [];
            let nextId = 1000000;
            const newId = () => nextId++;
            const objects = [], conns = [];
            const counts = {};
            function addObj(type, n) { objects.push(n); counts[type] = (counts[type] || 0) + 1; return n; }
            const OO = (c, p) => conns.push(node('C', [P.S('OO'), P.L(c), P.L(p)]));
            const OP = (c, p, prop) => conns.push(node('C', [P.S('OP'), P.L(c), P.L(p), P.S(prop)]));

            // ---- node roles ----
            const parentOf = new Array(nodes.length).fill(-1);
            nodes.forEach((n, i) => (n.children || []).forEach((c) => { parentOf[c] = i; }));
            const isJoint = new Array(nodes.length).fill(false);
            (gltf.skins || []).forEach((s) => s.joints.forEach((j) => { isJoint[j] = true; }));
            const local = nodes.map(nodeLocal);
            const world = new Array(nodes.length);
            function worldOf(i) {
                if (world[i]) return world[i];
                world[i] = parentOf[i] < 0 ? local[i] : mul4(worldOf(parentOf[i]), local[i]);
                return world[i];
            }
            nodes.forEach((_, i) => worldOf(i));

            // ---- models ----
            prog(0.02, 'nodes');
            const modelId = new Array(nodes.length);
            const restTRS = new Array(nodes.length);
            let sheared = 0;
            nodes.forEach((n, i) => {
                const id = modelId[i] = newId();
                const d = decompose(local[i]);
                if (d.shear > 1e-3) sheared++;
                const e = quatToEuler(d.q, null);
                restTRS[i] = { t: d.t, e, s: d.s, q: d.q };
                const kind = isJoint[i] ? 'LimbNode' : (n.mesh !== undefined ? 'Mesh' : 'Null');
                addObj('Model', node('Model', [P.L(id), P.S(objName(n.name || ('node_' + i), 'Model')), P.S(kind)], [
                    node('Version', [P.I(232)]),
                    P70([
                        ['Lcl Translation', 'Lcl Translation', '', 'A', d.t[0], d.t[1], d.t[2]],
                        ['Lcl Rotation', 'Lcl Rotation', '', 'A', e[0], e[1], e[2]],
                        ['Lcl Scaling', 'Lcl Scaling', '', 'A', d.s[0], d.s[1], d.s[2]],
                        ['InheritType', 'enum', '', '', 1],
                        ['DefaultAttributeIndex', 'int', 'Integer', '', 0],
                    ]),
                    node('Shading', [P.C(true)]),
                    node('Culling', [P.S('CullingOff')]),
                ]));
                if (isJoint[i]) {
                    const aid = newId();
                    addObj('NodeAttribute', node('NodeAttribute', [P.L(aid), P.S(objName(n.name || ('node_' + i), 'NodeAttribute')), P.S('LimbNode')], [
                        P70([['Size', 'double', 'Number', '', 1]]),
                        node('TypeFlags', [P.S('Skeleton')]),
                    ]));
                    OO(aid, id);
                }
            });
            nodes.forEach((n, i) => OO(modelId[i], parentOf[i] < 0 ? 0 : modelId[parentOf[i]]));
            if (sheared) warnings.push(`${sheared} node transform(s) have shear; FBX keeps only translation, rotation and scale`);

            // ---- materials and textures ----
            prog(0.06, 'materials');
            const images = gltf.images || [], textures = gltf.textures || [];
            const splits = [];
            const videoFor = {};      // uri -> video id
            const texCache = {};      // key -> texture id
            function imageInfo(imgIdx) {
                const img = images[imgIdx] || {};
                if (img.uri) return { uri: img.uri, bytes: null };
                if (img.bufferView !== undefined) {
                    const bv = gltf.bufferViews[img.bufferView];
                    const ext = img.mimeType === 'image/jpeg' ? 'jpg' : 'png';
                    return { uri: `textures/${(img.name || ('image_' + imgIdx)).replace(/[^\w.-]/g, '_')}.${ext}`, bytes: bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength) };
                }
                return null;
            }
            function textureFor(uri, bytes, label) {
                const key = uri;
                if (texCache[key]) return texCache[key];
                const base = uri.split('/').pop();
                let vid = videoFor[uri];
                if (!vid) {
                    vid = videoFor[uri] = newId();
                    const vkids = [
                        node('Type', [P.S('Clip')]),
                        P70([['Path', 'KString', 'XRefUrl', '', uri]]),
                        node('UseMipMap', [P.I(0)]),
                        node('Filename', [P.S(uri)]),
                        node('RelativeFilename', [P.S(uri)]),
                    ];
                    if (bytes) vkids.push(node('Content', [P.R(bytes)]));
                    addObj('Video', node('Video', [P.L(vid), P.S(objName(base, 'Video')), P.S('Clip')], vkids));
                }
                const tid = newId();
                addObj('Texture', node('Texture', [P.L(tid), P.S(objName(label || base, 'Texture')), P.S('')], [
                    node('Type', [P.S('TextureVideoClip')]),
                    node('Version', [P.I(202)]),
                    node('TextureName', [P.S(objName(label || base, 'Texture'))]),
                    P70([['UseMaterial', 'bool', '', '', 1]]),
                    node('Media', [P.S(objName(base, 'Video'))]),
                    node('FileName', [P.S(uri)]),
                    node('RelativeFilename', [P.S(uri)]),
                    node('ModelUVTranslation', [P.D(0), P.D(0)]),
                    node('ModelUVScaling', [P.D(1), P.D(1)]),
                    node('Texture_Alpha_Source', [P.S('None')]),
                    node('Cropping', [P.I(0), P.I(0), P.I(0), P.I(0)]),
                ]));
                OO(vid, tid);
                texCache[key] = tid;
                return tid;
            }
            function texOf(ref) {
                if (!ref || typeof ref.index !== 'number' || !textures[ref.index]) return null;
                const src = textures[ref.index].source;
                return src === undefined ? null : imageInfo(src);
            }
            function splitUri(uri, ch) {
                const dot = uri.lastIndexOf('.'), stem = dot > 0 ? uri.slice(0, dot) : uri;
                return `${stem}_${ch === 'G' ? 'roughness' : 'metallic'}.png`;
            }
            const matId = (gltf.materials || []).map((m, mi) => {
                const id = newId();
                const pbr = m.pbrMetallicRoughness || {};
                const bc = pbr.baseColorFactor || [1, 1, 1, 1];
                const metal = pbr.metallicFactor === undefined ? 1 : pbr.metallicFactor;
                const rough = pbr.roughnessFactor === undefined ? 1 : pbr.roughnessFactor;
                const em0 = m.emissiveFactor || [0, 0, 0];
                // with an emissive texture, apps read EmissiveFactor as the strength
                const emK = (m.emissiveTexture && Math.max(...em0) > 0) ? Math.max(...em0) : 1;
                const em = em0.map((v) => v / emK);
                const shin = Math.pow((1 - rough) * 10, 2);
                const alpha = (m.alphaMode === 'BLEND' || m.alphaMode === 'MASK') ? bc[3] : 1;
                addObj('Material', node('Material', [P.L(id), P.S(objName(m.name || ('material_' + mi), 'Material')), P.S('')], [
                    node('Version', [P.I(102)]),
                    node('ShadingModel', [P.S('Phong')]),
                    node('MultiLayer', [P.I(0)]),
                    P70([
                        ['DiffuseColor', 'Color', '', 'A', bc[0], bc[1], bc[2]],
                        ['DiffuseFactor', 'Number', '', 'A', 1],
                        ['EmissiveColor', 'Color', '', 'A', em[0], em[1], em[2]],
                        ['EmissiveFactor', 'Number', '', 'A', emK],
                        ['SpecularColor', 'Color', '', 'A', 1, 1, 1],
                        ['SpecularFactor', 'Number', '', 'A', 0.5],
                        ['Shininess', 'Number', '', 'A', shin],
                        ['ShininessExponent', 'Number', '', 'A', shin],
                        ['ReflectionColor', 'Color', '', 'A', 1, 1, 1],
                        ['ReflectionFactor', 'Number', '', 'A', metal],
                        ['TransparentColor', 'Color', '', 'A', 1, 1, 1],
                        ['TransparencyFactor', 'Number', '', 'A', 1 - alpha],
                        ['Opacity', 'Number', '', 'A', alpha],
                    ]),
                ]));
                const link = (info, prop, label) => { if (info) OP(textureFor(info.uri, info.bytes, label), id, prop); };
                const base = texOf(pbr.baseColorTexture);
                link(base, 'DiffuseColor');
                if (base && (m.alphaMode === 'BLEND' || m.alphaMode === 'MASK')) link(base, 'TransparentColor');
                link(texOf(m.normalTexture), 'NormalMap');
                link(texOf(m.emissiveTexture), 'EmissiveColor');
                const mr = texOf(pbr.metallicRoughnessTexture);
                if (mr) {
                    if (mr.bytes) warnings.push(`material "${m.name}": embedded metal/rough image not split`);
                    else {
                        const ru = splitUri(mr.uri, 'G'), mu = splitUri(mr.uri, 'B');
                        splits.push({ src: mr.uri, channel: 'G', out: ru }, { src: mr.uri, channel: 'B', out: mu });
                        link({ uri: ru }, 'ShininessExponent');
                        link({ uri: mu }, 'ReflectionFactor');
                    }
                }
                return id;
            });
            // splits may repeat when materials share one image
            const seenSplit = {};
            const uniqSplits = splits.filter((s) => (seenSplit[s.out] ? false : (seenSplit[s.out] = true)));

            // ---- skinned meshes: choose a clean bind frame ----
            // glTF IBMs may carry the viewer's skeleton->geometry matrix (non-uniform
            // scale / shear). Pick M = W_rest(root) * IBM_root as the mesh bind matrix:
            // then bone binds M * inv(IBM_j) are clean, and the leftover K = inv(C) * M
            // (C = the mesh model's own world matrix) is baked into the vertices.
            const skinBind = {};      // meshIdx -> { M, C, K, K3n }
            nodes.forEach((n, i) => {
                if (n.skin === undefined || n.mesh === undefined || skinBind[n.mesh]) return;
                const skin = gltf.skins[n.skin];
                if (skin.inverseBindMatrices === undefined) return;
                const ibm = read(skin.inverseBindMatrices);
                let r = skin.joints.findIndex((jn) => !isJoint[parentOf[jn]] || parentOf[jn] < 0);
                if (r < 0) r = 0;
                const M = mul4(worldOf(skin.joints[r]), Array.from(ibm.subarray(r * 16, r * 16 + 16)));
                const C = worldOf(i);
                const K = mul4(inv4(C) || C, M);
                const L = inv4(K);
                // normal matrix = inverse transpose of the 3x3 part
                const K3n = L ? [L[0], L[1], L[2], L[4], L[5], L[6], L[8], L[9], L[10]] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
                skinBind[n.mesh] = { M, C, K, K3n, ibm };
            });
            const xfP = (K, x, y, z) => [K[0] * x + K[4] * y + K[8] * z + K[12], K[1] * x + K[5] * y + K[9] * z + K[13], K[2] * x + K[6] * y + K[10] * z + K[14]];
            const xfV = (K, x, y, z) => [K[0] * x + K[4] * y + K[8] * z, K[1] * x + K[5] * y + K[9] * z, K[2] * x + K[6] * y + K[10] * z];
            const xfNd = (N, x, y, z) => [N[0] * x + N[1] * y + N[2] * z, N[3] * x + N[4] * y + N[5] * z, N[6] * x + N[7] * y + N[8] * z];
            const xfN = (N, x, y, z) => {
                const v = xfNd(N, x, y, z);
                const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l];
            };

            // ---- geometry ----
            prog(0.10, 'geometry');
            const geomOfMesh = {};    // meshIdx -> { id, vcount, offsets per primitive, matIdx list }
            const meshes = gltf.meshes || [];
            const geomOne = (mesh, mi) => {
                prog(0.10 + 0.45 * mi / Math.max(1, meshes.length), `geometry ${mi + 1}/${meshes.length}`);
                const prims = mesh.primitives.filter((p) => (p.mode === undefined || p.mode === 4) && p.attributes.POSITION !== undefined);
                if (prims.length < mesh.primitives.length) warnings.push(`mesh "${mesh.name}": ${mesh.primitives.length - prims.length} non-triangle primitive(s) skipped`);
                if (!prims.length) return;
                const pos = [], nrm = [], uv0 = [], uv1 = [], col = [], idx = [], pmat = [], offs = [];
                let base = 0, hasN = false, hasUV0 = false, hasUV1 = false, hasC = false;
                prims.forEach((p) => {
                    if (p.attributes.NORMAL !== undefined) hasN = true;
                    if (p.attributes.TEXCOORD_0 !== undefined) hasUV0 = true;
                    if (p.attributes.TEXCOORD_1 !== undefined) hasUV1 = true;
                    if (p.attributes.COLOR_0 !== undefined) hasC = true;
                });
                const matList = [];
                prims.forEach((p) => {
                    const P3 = read(p.attributes.POSITION), n = P3.length / 3;
                    offs.push(base);
                    const sb = skinBind[mi];
                    if (sb) { for (let e = 0; e < n; e++) pos.push(...xfP(sb.K, P3[e * 3], P3[e * 3 + 1], P3[e * 3 + 2])); }
                    else for (let k = 0; k < P3.length; k++) pos.push(P3[k]);
                    const fill = (arr, acc, w, def) => {
                        if (acc !== undefined) { const a = read(acc); const c = a.nc; for (let e = 0; e < n; e++) for (let k = 0; k < w; k++) arr.push(k < c ? a[e * c + k] : def[k]); }
                        else for (let e = 0; e < n; e++) for (let k = 0; k < w; k++) arr.push(def[k]);
                    };
                    if (hasN) {
                        const n0 = nrm.length;
                        fill(nrm, p.attributes.NORMAL, 3, [0, 0, 1]);
                        if (sb) for (let k = n0; k < nrm.length; k += 3) { const v = xfN(sb.K3n, nrm[k], nrm[k + 1], nrm[k + 2]); nrm[k] = v[0]; nrm[k + 1] = v[1]; nrm[k + 2] = v[2]; }
                    }
                    if (hasUV0) fill(uv0, p.attributes.TEXCOORD_0, 2, [0, 0]);
                    if (hasUV1) fill(uv1, p.attributes.TEXCOORD_1, 2, [0, 0]);
                    if (hasC) fill(col, p.attributes.COLOR_0, 4, [1, 1, 1, 1]);
                    const I = p.indices !== undefined ? read(p.indices) : Array.from({ length: n }, (_, k) => k);
                    let ml = matList.indexOf(p.material === undefined ? -1 : p.material);
                    if (ml < 0) { matList.push(p.material === undefined ? -1 : p.material); ml = matList.length - 1; }
                    for (let k = 0; k + 2 < I.length; k += 3) {
                        idx.push(I[k] + base, I[k + 1] + base, -(I[k + 2] + base) - 1);
                        pmat.push(ml);
                    }
                    base += n;
                });
                const vcount = base;
                const pvi = Int32Array.from(idx);
                // per polygon-vertex helpers
                const corner = new Int32Array(pvi.length);
                for (let k = 0; k < pvi.length; k++) corner[k] = pvi[k] < 0 ? -pvi[k] - 1 : pvi[k];
                const kids = [
                    node('Vertices', [P.d(pos)]),
                    node('PolygonVertexIndex', [P.i(pvi)]),
                    node('GeometryVersion', [P.I(124)]),
                ];
                const layerEls = [];
                if (hasN) {
                    const pn = new Float64Array(corner.length * 3);
                    for (let k = 0; k < corner.length; k++) { pn[k * 3] = nrm[corner[k] * 3]; pn[k * 3 + 1] = nrm[corner[k] * 3 + 1]; pn[k * 3 + 2] = nrm[corner[k] * 3 + 2]; }
                    kids.push(node('LayerElementNormal', [P.I(0)], [
                        node('Version', [P.I(101)]), node('Name', [P.S('')]),
                        node('MappingInformationType', [P.S('ByPolygonVertex')]),
                        node('ReferenceInformationType', [P.S('Direct')]),
                        node('Normals', [P.d(pn)]),
                    ]));
                    layerEls.push(['LayerElementNormal', 0]);
                }
                const uvLayer = (uv, li, nm) => {
                    const flipped = new Float64Array(uv.length);
                    for (let k = 0; k < uv.length; k += 2) { flipped[k] = uv[k]; flipped[k + 1] = 1 - uv[k + 1]; }
                    kids.push(node('LayerElementUV', [P.I(li)], [
                        node('Version', [P.I(101)]), node('Name', [P.S(nm)]),
                        node('MappingInformationType', [P.S('ByPolygonVertex')]),
                        node('ReferenceInformationType', [P.S('IndexToDirect')]),
                        node('UV', [P.d(flipped)]),
                        node('UVIndex', [P.i(corner)]),
                    ]));
                    layerEls.push(['LayerElementUV', li]);
                };
                if (hasUV0) uvLayer(uv0, 0, 'UVMap');
                if (hasUV1) uvLayer(uv1, 1, 'UVMap2');
                if (hasC) {
                    // glTF COLOR_0 is linear; FBX apps treat vertex colours as sRGB
                    const l2s = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
                    for (let k = 0; k < col.length; k++) if (k % 4 !== 3) col[k] = l2s(Math.min(1, Math.max(0, col[k])));
                    kids.push(node('LayerElementColor', [P.I(0)], [
                        node('Version', [P.I(101)]), node('Name', [P.S('Col')]),
                        node('MappingInformationType', [P.S('ByPolygonVertex')]),
                        node('ReferenceInformationType', [P.S('IndexToDirect')]),
                        node('Colors', [P.d(col)]),
                        node('ColorIndex', [P.i(corner)]),
                    ]));
                    layerEls.push(['LayerElementColor', 0]);
                }
                const single = matList.length === 1;
                kids.push(node('LayerElementMaterial', [P.I(0)], [
                    node('Version', [P.I(101)]), node('Name', [P.S('')]),
                    node('MappingInformationType', [P.S(single ? 'AllSame' : 'ByPolygon')]),
                    node('ReferenceInformationType', [P.S('IndexToDirect')]),
                    node('Materials', [P.i(single ? [0] : pmat)]),
                ]));
                layerEls.push(['LayerElementMaterial', 0]);
                const byLayer = {};
                layerEls.forEach(([t, li]) => { (byLayer[li] = byLayer[li] || []).push(t); });
                Object.keys(byLayer).forEach((li) => {
                    kids.push(node('Layer', [P.I(+li)], [node('Version', [P.I(100)])].concat(byLayer[li].map((t) => node('LayerElement', [], [node('Type', [P.S(t)]), node('TypedIndex', [P.I(+li)])])))));
                });
                const gid = newId();
                addObj('Geometry', node('Geometry', [P.L(gid), P.S(objName(mesh.name || ('mesh_' + mi), 'Geometry')), P.S('Mesh')], kids));
                geomOfMesh[mi] = { id: gid, vcount, offs, prims, matList };
            };
            for (let mi = 0; mi < meshes.length; mi++) { geomOne(meshes[mi], mi); const y = yieldUI(); if (y) await y; }

            // ---- connect geometry and materials to models ----
            nodes.forEach((n, i) => {
                if (n.mesh === undefined || !geomOfMesh[n.mesh]) return;
                const g = geomOfMesh[n.mesh];
                let target = modelId[i];
                if (isJoint[i]) {   // a joint can't also be the mesh model: hang a child mesh model under it
                    target = newId();
                    addObj('Model', node('Model', [P.L(target), P.S(objName((n.name || 'node') + '_mesh', 'Model')), P.S('Mesh')], [
                        node('Version', [P.I(232)]), P70([['InheritType', 'enum', '', '', 1]]),
                    ]));
                    OO(target, modelId[i]);
                }
                g.model = g.model || target;
                OO(g.id, target);
                g.matList.forEach((mt) => { if (mt >= 0 && matId[mt]) OO(matId[mt], target); });
                n._fbxMeshModel = target;
            });

            // ---- morph targets -> BlendShape ----
            prog(0.58, 'morph targets');
            const channelIds = {};    // meshIdx -> [channel ids]
            meshes.forEach((mesh, mi) => {
                const g = geomOfMesh[mi]; if (!g) return;
                const nT = Math.max(0, ...g.prims.map((p) => (p.targets || []).length));
                if (!nT) return;
                const names = (mesh.extras && mesh.extras.targetNames) || [];
                const bsId = newId();
                addObj('Deformer', node('Deformer', [P.L(bsId), P.S(objName(mesh.name || 'mesh', 'Deformer')), P.S('BlendShape')], [node('Version', [P.I(100)])]));
                OO(bsId, g.id);
                const ids = [];
                for (let t = 0; t < nT; t++) {
                    const ind = [], dpos = [], dnrm = [];
                    g.prims.forEach((p, pi) => {
                        const tg = (p.targets || [])[t]; if (!tg || tg.POSITION === undefined) return;
                        const dp = read(tg.POSITION), dn = tg.NORMAL !== undefined ? read(tg.NORMAL) : null;
                        for (let e = 0; e < dp.length / 3; e++) {
                            if (Math.abs(dp[e * 3]) + Math.abs(dp[e * 3 + 1]) + Math.abs(dp[e * 3 + 2]) < 1e-9 && !(dn && Math.abs(dn[e * 3]) + Math.abs(dn[e * 3 + 1]) + Math.abs(dn[e * 3 + 2]) > 1e-9)) continue;
                            ind.push(e + g.offs[pi]);
                            const sbm = skinBind[mi];
                            if (sbm) dpos.push(...xfV(sbm.K, dp[e * 3], dp[e * 3 + 1], dp[e * 3 + 2]));
                            else dpos.push(dp[e * 3], dp[e * 3 + 1], dp[e * 3 + 2]);
                            if (dn) dnrm.push(...(sbm ? xfNd(sbm.K3n, dn[e * 3], dn[e * 3 + 1], dn[e * 3 + 2]) : [dn[e * 3], dn[e * 3 + 1], dn[e * 3 + 2]]));
                            else dnrm.push(0, 0, 0);
                        }
                    });
                    const nm = names[t] || `target_${t}`;
                    const shId = newId(), chId = newId();
                    const w0 = (mesh.weights && mesh.weights[t]) || 0;
                    addObj('Geometry', node('Geometry', [P.L(shId), P.S(objName(nm, 'Geometry')), P.S('Shape')], [
                        node('Version', [P.I(100)]),
                        node('Indexes', [P.i(ind)]),
                        node('Vertices', [P.d(dpos)]),
                        node('Normals', [P.d(dnrm)]),
                    ]));
                    addObj('Deformer', node('Deformer', [P.L(chId), P.S(objName(nm, 'SubDeformer')), P.S('BlendShapeChannel')], [
                        node('Version', [P.I(100)]),
                        node('DeformPercent', [P.D(w0 * 100)]),
                        node('FullWeights', [P.d([100])]),
                        P70([['DeformPercent', 'Number', '', 'A', w0 * 100]]),
                    ]));
                    OO(shId, chId); OO(chId, bsId);
                    ids.push(chId);
                }
                channelIds[mi] = ids;
            });

            // ---- skins -> Skin + Clusters + BindPose ----
            prog(0.64, 'skins');
            const poseNodes = {};     // model id -> matrix
            nodes.forEach((n, i) => {
                if (n.skin === undefined || n.mesh === undefined || !geomOfMesh[n.mesh]) return;
                const skin = gltf.skins[n.skin], g = geomOfMesh[n.mesh];
                const meshModel = n._fbxMeshModel;
                const sbk = skinBind[n.mesh];
                const C = sbk ? sbk.C : worldOf(i);
                const MB = sbk ? sbk.M : C;      // bind matrix the IBMs are relative to
                const ibm = skin.inverseBindMatrices !== undefined ? read(skin.inverseBindMatrices) : null;
                const nJ = skin.joints.length;
                const perJ = Array.from({ length: nJ }, () => ({ ind: [], w: [] }));
                g.prims.forEach((p, pi) => {
                    for (let set = 0; set < 4; set++) {
                        const ja = p.attributes['JOINTS_' + set], wa = p.attributes['WEIGHTS_' + set];
                        if (ja === undefined || wa === undefined) break;
                        const J = read(ja), W = read(wa);
                        for (let e = 0; e < J.length / 4; e++) for (let k = 0; k < 4; k++) {
                            const w = W[e * 4 + k]; if (!(w > 0)) continue;
                            const j = J[e * 4 + k]; if (j >= nJ) continue;
                            perJ[j].ind.push(e + g.offs[pi]); perJ[j].w.push(w);
                        }
                    }
                });
                const skId = newId();
                addObj('Deformer', node('Deformer', [P.L(skId), P.S(objName(n.name || 'skin', 'Deformer')), P.S('Skin')], [
                    node('Version', [P.I(101)]), node('Link_DeformAcuracy', [P.D(50)]),
                ]));
                OO(skId, g.id);
                poseNodes[meshModel] = C;
                // the armature is the nearest non-joint ancestor of the joints (importers bind the mesh against it)
                let armNode = -1;
                for (const jn of skin.joints) {
                    let p = parentOf[jn];
                    while (p >= 0 && isJoint[p]) p = parentOf[p];
                    if (p >= 0) { armNode = p; break; }
                }
                const armW = armNode >= 0 ? worldOf(armNode) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
                if (armNode >= 0 && !poseNodes[modelId[armNode]]) poseNodes[modelId[armNode]] = armW;
                skin.joints.forEach((jn, j) => {
                    const ib = ibm ? Array.from(ibm.subarray(j * 16, j * 16 + 16)) : inv4(mul4(inv4(C) || C, worldOf(jn)));
                    const ibInv = inv4(ib) || worldOf(jn);
                    const link = mul4(MB, ibInv);          // bone world matrix at bind time
                    const tx = mul4(inv4(link) || link, C); // FBX "Transform": mesh bind relative to the bone
                    const cid = newId();
                    addObj('Deformer', node('Deformer', [P.L(cid), P.S(objName(nodes[jn].name || ('joint_' + j), 'SubDeformer')), P.S('Cluster')], [
                        node('Version', [P.I(100)]),
                        node('UserData', [P.S(''), P.S('')]),
                        node('Indexes', [P.i(perJ[j].ind)]),
                        node('Weights', [P.d(perJ[j].w)]),
                        node('Transform', [P.d(tx)]),
                        node('TransformLink', [P.d(link)]),
                        node('TransformAssociateModel', [P.d(armW)]),
                    ]));
                    OO(cid, skId);
                    OO(modelId[jn], cid);
                    if (!poseNodes[modelId[jn]]) poseNodes[modelId[jn]] = link;
                });
            });
            const poseIds = Object.keys(poseNodes);
            if (poseIds.length) {
                const pid = newId();
                addObj('Pose', node('Pose', [P.L(pid), P.S(objName('BindPose', 'Pose')), P.S('BindPose')], [
                    node('Type', [P.S('BindPose')]),
                    node('Version', [P.I(100)]),
                    node('NbPoseNodes', [P.I(poseIds.length)]),
                ].concat(poseIds.map((k) => node('PoseNode', [], [node('Node', [P.L(+k)]), node('Matrix', [P.d(poseNodes[k])])])))));
            }

            // ---- animation clips ----
            prog(0.70, 'animation');
            const anims = gltf.animations || [];
            let maxT = 0;
            const toTicks = (t) => Math.round(t * KTIME);
            function curve(times, vals, flagsKind) {
                const id = newId();
                const n = times.length;
                addObj('AnimationCurve', node('AnimationCurve', [P.L(id), P.S(objName('', 'AnimCurve')), P.S('')], [
                    node('Default', [P.D(vals[0] || 0)]),
                    node('KeyVer', [P.I(4008)]),
                    node('KeyTime', [P.l(times.map(toTicks))]),
                    node('KeyValueFloat', [P.f(vals)]),
                    node('KeyAttrFlags', [P.i([flagsKind === 'STEP' ? 0x00000002 : 0x00000004])]),
                    node('KeyAttrDataFloat', [P.f([0, 0, 9.419963346924634e-30, 0])]),
                    node('KeyAttrRefCount', [P.i([n])]),
                ]));
                return id;
            }
            // Euler curves can't slerp: add keys until linear Euler stays within tol of the slerp
            function rotKeys(times, quats, step) {
                const outT = [], outE = [];
                let prevE = null;
                const push = (t, q) => { const e = quatToEuler(q, prevE); prevE = e; outT.push(t); outE.push(e); };
                push(times[0], quats[0]);
                for (let k = 1; k < times.length; k++) {
                    const qa = quats[k - 1], qb = quats[k], ta = times[k - 1], tb = times[k];
                    if (step) { push(tb, qb); continue; }
                    const seg = (ua, ub, ea, depth) => {
                        const eb = quatToEuler(slerp(qa, qb, ub), ea);
                        const um = (ua + ub) / 2;
                        const em = [(ea[0] + eb[0]) / 2, (ea[1] + eb[1]) / 2, (ea[2] + eb[2]) / 2];
                        // also split long arcs: apps that lerp quaternion keys drift from slerp there
                        if (depth < 7 && (quatAngle(eulerToQuat(em), slerp(qa, qb, um)) > 0.05 || quatAngle(slerp(qa, qb, ua), slerp(qa, qb, ub)) > 12)) {
                            const emid = seg(ua, um, ea, depth + 1);
                            return seg(um, ub, emid, depth + 1);
                        }
                        prevE = eb; outT.push(ta + (tb - ta) * ub); outE.push(eb);
                        return eb;
                    };
                    seg(0, 1, prevE, 0);
                }
                return { t: outT, e: outE };
            }
            // every clip keys everything that any clip animates, so switching clips in an
            // app never leaves a bone in the pose of the previous clip
            const animatedPaths = {};
            anims.forEach((a) => a.channels.forEach((ch) => {
                if (ch.target.node !== undefined) (animatedPaths[ch.target.node] = animatedPaths[ch.target.node] || {})[ch.target.path] = true;
            }));
            function restValue(ni, path) {
                const r = restTRS[ni];
                if (path === 'translation') return r.t;
                if (path === 'rotation') return r.q;
                if (path === 'scale') return r.s;
                const mesh = meshes[nodes[ni].mesh] || {}, nT = (channelIds[nodes[ni].mesh] || []).length;
                return Array.from({ length: nT }, (_, k) => (mesh.weights && mesh.weights[k]) || 0);
            }
            const animOne = (anim, ai) => {
                prog(0.70 + 0.25 * ai / Math.max(1, anims.length), `animation ${ai + 1}/${anims.length}`);
                const name = anim.name || ('clip_' + ai);
                const stId = newId(), lyId = newId();
                let t0 = Infinity, t1 = 0;
                const groups = {};    // node -> {translation, rotation, scale, weights}
                anim.channels.forEach((ch) => {
                    if (ch.target.node === undefined) return;
                    (groups[ch.target.node] = groups[ch.target.node] || {})[ch.target.path] = anim.samplers[ch.sampler];
                });
                Object.keys(animatedPaths).forEach((ni) => Object.keys(animatedPaths[ni]).forEach((path) => {
                    const gs = groups[ni] = groups[ni] || {};
                    if (!gs[path]) gs[path] = { constVals: restValue(+ni, path) };
                }));

                Object.keys(groups).forEach((ni) => {
                    ni = +ni;
                    const gset = groups[ni];
                    const tgtModel = modelId[ni];
                    const sample = (smp) => {
                        if (smp.constVals) return { t: [0], v: [smp.constVals], step: false };
                        const tt = Array.from(read(smp.input)), vv = read(smp.output);
                        const nc = vv.nc, cub = smp.interpolation === 'CUBICSPLINE';
                        const vals = [];
                        for (let k = 0; k < tt.length; k++) {
                            const off = cub ? (k * 3 + 1) * nc : k * nc;
                            vals.push(Array.from(vv.subarray(off, off + nc)));
                        }
                        tt.forEach((t) => { if (t < t0) t0 = t; if (t > t1) t1 = t; });
                        return { t: tt, v: vals, step: smp.interpolation === 'STEP' };
                    };
                    const vecCurves = (label, prop, smp, conv) => {
                        const s = sample(smp);
                        const vals = s.v.map(conv);
                        const cn = newId();
                        addObj('AnimationCurveNode', node('AnimationCurveNode', [P.L(cn), P.S(objName(label, 'AnimCurveNode')), P.S('')], [
                            P70(['X', 'Y', 'Z'].map((c, k) => ['d|' + c, 'Number', '', 'A', vals[0][k]])),
                        ]));
                        OO(cn, lyId); OP(cn, tgtModel, prop);
                        ['X', 'Y', 'Z'].forEach((c, k) => OP(curve(s.t, vals.map((v) => v[k]), s.step ? 'STEP' : ''), cn, 'd|' + c));
                    };
                    if (gset.translation) vecCurves('T', 'Lcl Translation', gset.translation, (v) => v);
                    if (gset.scale) vecCurves('S', 'Lcl Scaling', gset.scale, (v) => v);
                    if (gset.rotation) {
                        const s = sample(gset.rotation);
                        const rk = rotKeys(s.t, s.v, s.step);
                        const cn = newId();
                        addObj('AnimationCurveNode', node('AnimationCurveNode', [P.L(cn), P.S(objName('R', 'AnimCurveNode')), P.S('')], [
                            P70(['X', 'Y', 'Z'].map((c, k) => ['d|' + c, 'Number', '', 'A', rk.e[0][k]])),
                        ]));
                        OO(cn, lyId); OP(cn, tgtModel, 'Lcl Rotation');
                        ['X', 'Y', 'Z'].forEach((c, k) => OP(curve(rk.t, rk.e.map((v) => v[k]), s.step ? 'STEP' : ''), cn, 'd|' + c));
                    }
                    if (gset.weights) {
                        const mi = nodes[ni].mesh, chs = channelIds[mi];
                        if (chs) {
                            const cw = gset.weights.constVals;
                            const tt = cw ? [0] : Array.from(read(gset.weights.input)), vv = cw ? Float64Array.from(cw) : read(gset.weights.output);
                            const nT = chs.length, cub = gset.weights.interpolation === 'CUBICSPLINE';
                            tt.forEach((t) => { if (t < t0) t0 = t; if (t > t1) t1 = t; });
                            chs.forEach((chId, k) => {
                                const vals = tt.map((_, e) => 100 * vv[(cub ? (e * 3 + 1) : e) * nT + k]);
                                const cn = newId();
                                addObj('AnimationCurveNode', node('AnimationCurveNode', [P.L(cn), P.S(objName('DeformPercent', 'AnimCurveNode')), P.S('')], [
                                    P70([['d|DeformPercent', 'Number', '', 'A', vals[0]]]),
                                ]));
                                OO(cn, lyId); OP(cn, chId, 'DeformPercent');
                                OP(curve(tt, vals, gset.weights.interpolation === 'STEP' ? 'STEP' : ''), cn, 'd|DeformPercent');
                            });
                        }
                    }
                });
                if (!isFinite(t0)) { t0 = 0; t1 = 0; }
                maxT = Math.max(maxT, t1);
                addObj('AnimationStack', node('AnimationStack', [P.L(stId), P.S(objName(name, 'AnimStack')), P.S('')], [
                    P70([
                        ['LocalStart', 'KTime', 'Time', '', toTicks(t0)],
                        ['LocalStop', 'KTime', 'Time', '', toTicks(t1)],
                        ['ReferenceStart', 'KTime', 'Time', '', toTicks(t0)],
                        ['ReferenceStop', 'KTime', 'Time', '', toTicks(t1)],
                    ]),
                ]));
                addObj('AnimationLayer', node('AnimationLayer', [P.L(lyId), P.S(objName('BaseLayer', 'AnimLayer')), P.S('')], []));
                OO(lyId, stId);
                anim._fbx = { name, t0, t1 };
            };
            for (let ai = 0; ai < anims.length; ai++) { animOne(anims[ai], ai); const y = yieldUI(); if (y) await y; }

            // ---- document ----
            prog(0.96, 'writing file');
            const now = new Date();
            const creator = opts.creator || 'Sketchfab Ripper';
            const defs = [node('Version', [P.I(100)]), node('Count', [P.I(Object.values(counts).reduce((a, b) => a + b, 1))]),
                node('ObjectType', [P.S('GlobalSettings')], [node('Count', [P.I(1)])])]
                .concat(Object.keys(counts).map((t) => node('ObjectType', [P.S(t)], [node('Count', [P.I(counts[t])])])));
            const fpsMode = { 120: 1, 100: 2, 60: 3, 50: 4, 48: 5, 30: 6, 25: 10, 24: 11, 1000: 12, 96: 15, 72: 16 }[fps] || 14;
            const roots = [
                node('FBXHeaderExtension', [], [
                    node('FBXHeaderVersion', [P.I(1003)]),
                    node('FBXVersion', [P.I(7400)]),
                    node('EncryptionType', [P.I(0)]),
                    node('CreationTimeStamp', [], [
                        node('Version', [P.I(1000)]), node('Year', [P.I(now.getFullYear())]), node('Month', [P.I(now.getMonth() + 1)]),
                        node('Day', [P.I(now.getDate())]), node('Hour', [P.I(now.getHours())]), node('Minute', [P.I(now.getMinutes())]),
                        node('Second', [P.I(now.getSeconds())]), node('Millisecond', [P.I(0)]),
                    ]),
                    node('Creator', [P.S(creator)]),
                ]),
                node('FileId', [P.R(new Uint8Array([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1]))]),
                node('CreationTime', [P.S('1970-01-01 10:00:00:000')]),
                node('Creator', [P.S(creator)]),
                node('GlobalSettings', [], [
                    node('Version', [P.I(1000)]),
                    P70([
                        ['UpAxis', 'int', 'Integer', '', 1], ['UpAxisSign', 'int', 'Integer', '', 1],
                        ['FrontAxis', 'int', 'Integer', '', 2], ['FrontAxisSign', 'int', 'Integer', '', 1],
                        ['CoordAxis', 'int', 'Integer', '', 0], ['CoordAxisSign', 'int', 'Integer', '', 1],
                        ['OriginalUpAxis', 'int', 'Integer', '', 1], ['OriginalUpAxisSign', 'int', 'Integer', '', 1],
                        ['UnitScaleFactor', 'double', 'Number', '', 100], ['OriginalUnitScaleFactor', 'double', 'Number', '', 100],
                        ['AmbientColor', 'ColorRGB', 'Color', '', 0, 0, 0],
                        ['DefaultCamera', 'KString', '', '', 'Producer Perspective'],
                        ['TimeMode', 'enum', '', '', fpsMode],
                        ['TimeProtocol', 'enum', '', '', 2],
                        ['SnapOnFrameMode', 'enum', '', '', 0],
                        ['TimeSpanStart', 'KTime', 'Time', '', 0],
                        ['TimeSpanStop', 'KTime', 'Time', '', toTicks(maxT || 1)],
                        ['CustomFrameRate', 'double', 'Number', '', fps],
                        ['CurrentTimeMarker', 'int', 'Integer', '', -1],
                    ]),
                ]),
                node('Documents', [], [
                    node('Count', [P.I(1)]),
                    node('Document', [P.L(newId()), P.S(''), P.S('Scene')], [
                        P70([['SourceObject', 'object', '', ''], ['ActiveAnimStackName', 'KString', '', '', anims.length ? anims[0]._fbx.name : '']]),
                        node('RootNode', [P.L(0)]),
                    ]),
                ]),
                node('References', [], []),
                node('Definitions', [], defs),
                node('Objects', [], objects),
                node('Connections', [], conns),
                node('Takes', [], [node('Current', [P.S('')])].concat(anims.map((a) => node('Take', [P.S(a._fbx.name)], [
                    node('FileName', [P.S(a._fbx.name.replace(/[^\w.-]/g, '_') + '.tak')]),
                    node('LocalTime', [P.L(toTicks(a._fbx.t0)), P.L(toTicks(a._fbx.t1))]),
                    node('ReferenceTime', [P.L(toTicks(a._fbx.t0)), P.L(toTicks(a._fbx.t1))]),
                ])))),
            ];
            anims.forEach((a) => { delete a._fbx; });
            nodes.forEach((n) => { delete n._fbxMeshModel; });
            if (opts.deflate) {
                try { await compressArrays(roots, opts.deflate, (f) => prog(0.96 + 0.035 * f, 'compressing')); }
                catch (e) { warnings.push('compression failed, file written uncompressed: ' + e.message); (function clr(n) { n.props.forEach((p) => { delete p.z; }); n.children.forEach(clr); })({ props: [], children: roots }); }
            }
            prog(0.995, 'writing file');
            { const y = yieldUI(); if (y) await y; }
            const fbx = writeNodes(roots, 7400);
            prog(1, 'done');
            return {
                fbx, splits: uniqSplits, warnings,
                stats: { models: counts.Model || 0, geometries: counts.Geometry || 0, materials: counts.Material || 0, textures: counts.Texture || 0, clusters: objects.filter((o) => o.props[2] && o.props[2].v === 'Cluster').length, stacks: counts.AnimationStack || 0, curves: counts.AnimationCurve || 0 },
            };
        }
        return { gltfToFbx, _test: { quatToEuler, eulerToQuat, decompose, writeNodes, node, P } };
    })();

    // ====================================================================
    // Script interceptor
    // ====================================================================
    (function installInterceptor() {
        const Ev = function (s, t) {
            this.script = s; this.target = t;
            this._cancel = false; this._replace = null; this._stop = false;
        };
        Ev.prototype.preventDefault = function () { this._cancel = true; };
        Ev.prototype.stopPropagation = function () { this._stop = true; };
        Ev.prototype.replacePayload = function (p) { this._replace = p; };

        function dispatch(script, target) {
            if (!script || script.tagName !== 'SCRIPT') return;
            const e = new Ev(script, target);
            if (typeof window.onbeforescriptexecute === 'function') {
                try { window.onbeforescriptexecute(e); } catch (err) { console.error(err); }
            }
            if (e._cancel) { script.textContent = ''; script.remove(); }
            else if (typeof e._replace === 'string') { script.textContent = e._replace; }
        }

        const obs = new MutationObserver((ms) => {
            for (let i = 0; i < ms.length; i++) {
                const m = ms[i];
                const an = m.addedNodes;
                for (let j = 0; j < an.length; j++) {
                    const n = an[j];
                    if (n && n.tagName === 'SCRIPT') dispatch(n, m.target);
                }
            }
        });
        obs.observe(window.document, { childList: true, subtree: true });
    })();

    const RE = {
        renderInto1      : /A\.renderInto\(n,E,R/g,
        renderInto2      : /g\.renderInto=function\(e,i,r/g,
        drawArrays       : /t\.drawArrays\(t\.TRIANGLES,0,6\)/g,
        getResourceImage : /getResourceImage:function\(e,t\){/g,
        drawGeometry     : /(this\._stateCache\.drawGeometry\(this\._graphicContext,t\))/g,
    };

    const patchedSrc = {};

    window.onbeforescriptexecute = (e) => {
        // Only handle the script that triggered the event, and each bundle URL once.
        // (Looping over all siblings re-executed the viewer bundle repeatedly and
        // exhausted WebGL contexts / RAM.)
        [e.script].forEach((node) => {
            if (!node || node.tagName !== 'SCRIPT') return;
            if (node.__ripperOwn) return;
            const src = node.src || '';
            if (src.indexOf('web/dist/') < 0 && src.indexOf('standaloneViewer') < 0) return;
            if (patchedSrc[src]) { warn('bundle already patched, dropping duplicate:', src.split('/').pop()); e.preventDefault(); e.stopPropagation(); return; }
            patchedSrc[src] = true;

            let js = '';
            try {
                const req = new XMLHttpRequest();
                req.open('GET', src, false);
                req.send('');
                if (req.status >= 200 && req.status < 300) js = req.responseText || '';
                else err('bundle fetch status', req.status, src.split('/').pop());
            } catch (fe) { err('bundle fetch failed:', fe.message, src.split('/').pop()); }
            if (!js) { delete patchedSrc[src]; return; }   // leave the original script running

            e.preventDefault();
            e.stopPropagation();

            let ret, applied = [];
            for (let rk in RE) if (RE.hasOwnProperty(rk)) RE[rk].lastIndex = 0;

            if ((ret = RE.renderInto1.exec(js))) {
                js = js.slice(0, ret.index + ret[0].length) + ',i' + js.slice(ret.index + ret[0].length);
                applied.push('patch_0');
            }
            if ((ret = RE.renderInto2.exec(js))) {
                js = js.slice(0, ret.index + ret[0].length) + ',image_data' + js.slice(ret.index + ret[0].length);
                applied.push('patch_1');
            }
            if ((ret = RE.drawArrays.exec(js))) {
                js = js.slice(0, ret.index + ret[0].length) + ',window.drawhookimg(t,image_data)' + js.slice(ret.index + ret[0].length);
                applied.push('patch_2');
            }
            if ((ret = RE.getResourceImage.exec(js))) {
                js = js.slice(0, ret.index + ret[0].length) + 'e = window.drawhookcanvas(e,this._imageModel);' + js.slice(ret.index + ret[0].length);
                applied.push('patch_3');
            }
            if ((ret = RE.drawGeometry.exec(js))) {
                js = js.slice(0, ret.index + ret[1].length) + ';try{window.attachbody(t);}catch(_){}' + js.slice(ret.index + ret[1].length);
                applied.push('patch_4');
                setTimeout(addbtnfunc, 2000);
            }

            if (applied.length) {
                window._anyAnchorsMatched = true;
                try { sessionStorage.removeItem('ripper_reloaded'); } catch (e) {}
                log('patched', src.split('/').pop(), '→', applied.join(','));
            }

            const s = document.createElement('script');
            s.__ripperOwn = true;
            s.type = 'text/javascript';
            s.text = js;
            (document.head || document.getElementsByTagName('head')[0]).appendChild(s);
        });
    };

    (function kickoff() {
        const isViewerFrame = (window.self !== window.top) || (location.pathname.indexOf('/embed') !== -1);
        if (!isViewerFrame) return;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => { setTimeout(addbtnfunc, 500); });
        } else {
            setTimeout(addbtnfunc, 500);
        }
    })();
})();

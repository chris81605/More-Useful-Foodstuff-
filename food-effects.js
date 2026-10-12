(function () {
    "use strict";

    // 存檔欄位：玩家自訂設定與攝取紀錄均與原版食物定義分離。
    // ==================================================================
    // 01. 持久化鍵值與食物分類設定
    // 所有存檔鍵名均為既有格式，重構不得更名，以維持舊存檔相容。
    // ==================================================================
    const KEY = 'foodEffectsOverrides';
    const TYPE_KEY = 'foodEffectsTypeOverrides';
    const INTAKE_KEY = 'foodEffectsIntakeHistory';

    // 消化時間可選 60、90、120、240、360 分鐘；容量在單筆紀錄到期後一次釋放。
    // 飽食度隨消化進度線性下降，食物技能 Buff 每次持續消化時間的一半。
    const INTAKE = Object.freeze({
        capacity: 100,
        windowSeconds: 5400,
        costs: Object.freeze({
            meal: 40,
            snack: 15,
            fruit: 15,
            dessert: 20,
            drink: 10,
            erotic_drink: 15,
            alcohol: 25,
            non_food: 30
        })
    });
    // 消化時間為全域模組設定，保存在遊戲存檔內；既有紀錄依目前設定重新計算。
    const DIGESTION_KEY = 'foodEffectsDigestionMinutes';
    const DIGESTION_OPTIONS = Object.freeze([60, 90, 120, 240, 360]);
    function digestionMinutes(vars = state()) {
        const value = Number(vars?.[DIGESTION_KEY]);
        return DIGESTION_OPTIONS.includes(value) ? value : 90;
    }
    function digestionSeconds(vars = state()) {
        return digestionMinutes(vars) * 60;
    }
    // 各食物類型的預設效果；amount 會交由原版 statChange 函式處理。
    const TYPES = Object.freeze({
        meal: { label: '主食', effects: { fatigueRecovery: { amount: 25 } } },
        snack: { label: '零食', effects: { fatigueRecovery: { amount: 8 } } },        
        fruit: { label: '水果', effects: { fatigueRecovery: { amount: 10 } } },
        dessert: { label: '點心', effects: { fatigueRecovery: { amount: 6 }, stressRelief: { amount: 3 } } },
        drink: { label: '一般飲料', effects: { fatigueRecovery: { amount: 3 } } },
        erotic_drink: { label: '情色飲料', effects: { fatigueRecovery: { amount: 5 }, arousalIncrease: { amount: 100 } } },
        alcohol: { label: '酒類', effects: { fatigueRecovery: { amount: 5 }, intoxication: { amount: 60 }, traumaRelief: { amount: 30 } } },
        non_food: { label: '非食物', effects: { fatigueRecovery: { amount: 1 }, stressIncrease: { amount: 3 } } }
    });

    // 特殊物品的預設分類；不寫入 setup.foodstuff。
    // ID 優先於 category/tags/關鍵字：避免特殊飲料誤判成普通食物。
    const SPECIAL = Object.freeze({
        bottle_of_breast_milk:'erotic_drink',baby_bottle_of_breast_milk:'erotic_drink',bottle_of_semen:'erotic_drink',
        red_wine:'alcohol',white_wine:'alcohol',wolfbrew:'alcohol',ghostbrew:'alcohol',
        orange_juice:'drink',lemonade:'drink',poached_pear:'dessert',
        honey:'snack',jam:'snack',bottle_of_milk:'drink',
        wild_honeycomb:'non_food',oyster_pearl:'non_food',bait_worm:'non_food',baitfish:'non_food'
    });
    const BLOCKED_VEG = new Set(['potato','wheat','rice']);
    const SWEET_WORDS=/cake|cookie|biscuit|pudding|chocolate|ice_cream|pie|tart|sweet|brownie|muffin|donut|doughnut|pancake|waffle|custard|scone|jam|honey|candy|pastry|poached_pear/i;
    const MEAL_WORDS=/pizza|burger|steak|roast|stew|soup|sandwich|pasta|spaghetti|noodle|curry|omelette|salad|risotto|lasagna|fish_and_chips|breakfast|dinner|lunch|chowder|baked|grilled/i;
    // 效果處理器統一呼叫原版 statChange，避免自行修改角色狀態。
    // ==================================================================
    // 02. 原生狀態效果與說明文字
    // HANDLERS 僅包裝原版 statChange；PARAM_HELP 為 UI 說明，不參與運算。
    // ==================================================================
    const HANDLERS = Object.freeze({
        fatigueRecovery:{label:'恢復疲勞',apply:v=>statChange.tiredness(-v),sign:-1},
        stressRelief:{label:'緩解壓力',apply:v=>statChange.stress(-v),sign:-1},
        stressIncrease:{label:'增加壓力',apply:v=>statChange.stress(v),sign:1},
        traumaRelief:{label:'緩解創傷',apply:v=>statChange.trauma(-v),sign:-1},
        intoxication:{label:'增加醉酒',apply:v=>statChange.drunk(v),sign:1},
        arousalIncrease:{label:'增加興奮',apply:v=>statChange.arousal(v),sign:1}
    });
    // 數值換算依原版 stat-changes.js；不改變 Handler 的傳參或效果計算。
    const PARAM_HELP = Object.freeze({
        fatigueRecovery: ['每 1 點恢復 20 點疲勞（疲勞上限 2000，約 1%）。', '例：5 點恢復約 5%，25 點恢復約 25%。建議 3～25；超過現有疲勞的部分不會額外儲存。'],
        stressRelief: ['每 1 點降低 80 點壓力；若壓力上限為 10000，相當於 0.8%。', '例：5 點降低 400 點（約 4%）；10 點降低 800 點（約 8%）。建議 1～10。'],
        stressIncrease: ['每 1 點通常增加 40 點壓力（上限 10000 時約 0.4%）。', '醉酒時每點可能降為 10～30 點，取決於目前醉酒值。例：5 點通常增加 200 點。建議 1～10。'],
        traumaRelief: ['每 1 點基本降低 1.5 點創傷，並依自控程度乘以 1～2 倍。', '一般約降低 1.5～3 點；在醫院或精神病院且非戰鬥時，再加倍。例：30 點約降低 45～90 點。建議 5～40。'],
        intoxication: ['每 1 點增加「設定值 × 醉酒敏感度」的醉酒值。', '原版一瓶酒的基準是 60 點。植物愛好者特質會使正向醉酒效果再乘 1.5；醉酒超過上限時，原版可能將溢出轉為疲勞與創傷。建議 10～60。'],
        arousalIncrease: ['每 1 點基準增加 1 點興奮值，並受角色特質、春藥與體溫等倍率影響。', '例：100 點在無額外倍率時增加約 100 點興奮；實際變化可能不同。建議 25～200。']
    });
    const INTAKE_HELP = ['每 1 點占用每小時 100 點攝取額度的 1%。', '例：10 點可連續食用 10 次；40 點可食用 2 次，剩下 20 點。每筆占用在遊戲時間經過 60 分鐘後一次釋放，消化條的下降不會提前返還額度。'];
    const EFFECT_STAT = Object.freeze({
        fatigueRecovery: {stat: 'tiredness', direction: -1},
        stressRelief: {stat: 'stress', direction: -1},
        stressIncrease: {stat: 'stress', direction: 1},
        traumaRelief: {stat: 'trauma', direction: -1},
        intoxication: {stat: 'drunk', direction: 1, hardStop: true},
        arousalIncrease: {stat: 'arousal', direction: 1}
    });

    // 擴充處理器與內建處理器分離；不修改原版資料或預設效果。
    // ==================================================================
    // 03. 可擴充 Handler 註冊 API
    // registerHandler(id, definition) 為公開入口；defaults.items/types/match 採 OR。
    // 此處只驗證與保存定義，實際效果執行由 evaluate/eat 處理。
    // ==================================================================
    const CUSTOM_HANDLERS = new Map();
    function getHandler(id) {
        return CUSTOM_HANDLERS.get(id) || HANDLERS[id] || null;
    }
    function registerHandler(id, definition) {
        if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(id))
            throw new TypeError('Handler ID must be an identifier.');
        if (!definition || typeof definition !== 'object' || typeof definition.apply !== 'function')
            throw new TypeError('Handler requires an apply(context, effect) function.');
        if (definition.canApply !== undefined && typeof definition.canApply !== 'function')
            throw new TypeError('canApply must be a function.');
        if (definition.describe !== undefined && typeof definition.describe !== 'function')
            throw new TypeError('describe must be a function.');
        // defaults 可依物品 ID、食物類型或自訂判斷式動態分配預設效果。
        // 三種條件為 OR；全部省略則不自動分配。
        const preset = definition.defaults;
        if (preset !== undefined) {
            if (!obj(preset)) throw new TypeError('defaults must be an object.');
            for (const key of ['items', 'types']) {
                if (preset[key] !== undefined && (!Array.isArray(preset[key]) || !preset[key].every(x => typeof x === 'string')))
                    throw new TypeError(`defaults.${key} must be a string array.`);
            }
            if (preset.match !== undefined && typeof preset.match !== 'function')
                throw new TypeError('defaults.match must be a function.');
            if (!Number.isFinite(preset.amount) || preset.amount <= 0 || preset.amount > 10000)
                throw new RangeError('defaults.amount must be between 0 and 10000 (exclusive of 0).');
        }
        const normalized = Object.freeze({
            ...definition,
            label: String(definition.label || id),
            defaults: preset ? Object.freeze({
                amount: preset.amount,
                items: Object.freeze([...(preset.items || [])]),
                types: Object.freeze([...(preset.types || [])]),
                match: preset.match || null
            }) : null,
            // 未提供狀態規則的效果自行決定是否可用。
            rule: definition.rule || EFFECT_STAT[id] || null
        });
        CUSTOM_HANDLERS.set(id, normalized);
        return normalized;
    }
    function unregisterHandler(id) {
        return CUSTOM_HANDLERS.delete(id);
    }
    function handlerEntries() {
        return [...new Set([...Object.keys(HANDLERS), ...CUSTOM_HANDLERS.keys()])]
            .map(id => [id, getHandler(id)]);
    }
    function handlerContext(id, config, before, intake) {
        return {foodId: id, food: window.setup?.foodstuff?.[id], config,
            state: state(), before, intake};
    }
    const copy=x=>JSON.parse(JSON.stringify(x));
    const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
    const state=()=>window.State?.variables;
    // 依原版 category、tags 與物品 ID 推導預設類型。
    // ==================================================================
    // 04. 分類推導與預設效果合併
    // classify 將原版 foodstuff.category/tags 映射至模組自己的類型。
    // applyRegisteredDefaults 只補未設定的效果；玩家覆寫稍後合併。
    // ==================================================================
    function classify(id,food){
        if(Object.prototype.hasOwnProperty.call(SPECIAL,id))return SPECIAL[id];
        const cat=food.category, tags=food.food?.tags||[];
        if(tags.includes('alcohol'))return 'alcohol';
        if(tags.includes('drink'))return 'drink';
        if(cat==='dish'){
            if(tags.includes('sweet')||SWEET_WORDS.test(id))return 'dessert';
            if(MEAL_WORDS.test(id))return 'meal';
            return 'snack';
        }
        if(cat==='fruit')return 'fruit';
        if(cat==='vegetable'&&!BLOCKED_VEG.has(id))return 'snack';
        return 'non_food';
    }
    // 所有原版食物資料預設可食用；玩家仍可逐項停用。
    function enabledDefault(id, food, type) {
        return true;
    }
    function mergeEffects(target, patch) {
        if (!obj(patch)) return;
        for (const [key, value] of Object.entries(patch)) {
            if (!getHandler(key)) continue;
            if (value === null) { delete target[key]; continue; }
            const amount = Number(value?.amount);
            if (obj(value) && Number.isFinite(amount) && amount >= 0 && amount <= 10000)
                target[key] = {amount};
        }
    }
    /**
     * 將已註冊 Handler 的預設效果套用到符合條件的食物。
     * items / types / match 為 OR；同一 Handler 即使符合多項也只套用一次。
     * 僅填補尚未存在的效果，玩家覆寫在 get() 最後合併。
     * food 為 null 時（類型設定預覽），只判斷 types。
     */
    function applyRegisteredDefaults(id, food, type, effects) {
        for (const [key, handler] of CUSTOM_HANDLERS) {
            const preset = handler.defaults;
            if (!preset) continue;
            let matched = preset.types.includes(type) || (id != null && preset.items.includes(id));
            if (!matched && food && preset.match) {
                try { matched = !!preset.match(food, id, type); }
                catch (error) { console.warn('[More Useful Foodstuff] Default matcher failed', key, error); }
            }
            if (matched && !Object.prototype.hasOwnProperty.call(effects, key))
                effects[key] = {amount: preset.amount};
        }
    }
    // ==================================================================
    // 05. 已停用的測試註冊
    // 保留範例但不執行，避免影響食物可食用判定。
    // ==================================================================
    /* 測試用註冊已停用，保留範例供開發參考。
    // 示範用空效果：預設分配給所有主食，但不參與食用判定或狀態變更。
    registerHandler('emptyMealEffect', {
        label: '預留效果（尚無作用）',
        defaults: {types: ['meal'], amount: 1},
        canApply() { return false; },
        apply() {},
        describe() { return '目前沒有任何效果'; },
        help: '預留給未來擴充的測試效果；目前不會改變任何角色狀態。'
    });
    */
    // 限時技能增益：獨立存檔，不改動原版技能數值；amount = 百分比。
    // ==================================================================
    // 06. 限時技能 Buff：設定、存檔、計算與註冊
    // 技能 Buff 的強度不疊加；重複食用延長剩餘時間。
    // 預設分配：主食 +10% 一般、情色飲料 +20% 性技能、蘑菇/松露 +15% 學科。
    // 體能與意志 Handler 仍註冊，但不自動分配。
    // ==================================================================
    const BUFF_KEY = 'foodEffectsSkillBuffs';
    // 食物技能增益的單次持續時間為目前消化時間的一半。
    function foodBuffDurationSeconds(vars = state()) {
        return digestionSeconds(vars) / 2;
    }
    const BUFF_GROUPS = Object.freeze({
        physique: {label:'體能', skills:['physique']},
        willpower: {label:'意志', skills:['willpower']},
        general: {label:'一般技能', skills:['skulduggery','danceskill','swimmingskill','athletics','tending','housekeeping']},
        sexual: {label:'性技能', skills:['seductionskill','oralskill','chestskill','handskill','bottomskill','analskill','vaginalskill','feetskill','thighskill','penileskill']},
        academic: {label:'學科', skills:['english','maths','science','history']}
    });
    const BUFF_SKILL_GROUP = new Map(Object.entries(BUFF_GROUPS)
        .flatMap(([group, info]) => info.skills.map(skill => [skill,group])));
    // 集中管理食物的限時技能增益分配；不更動 Handler API。
    // 僅指定三組，體能與意志維持未自動分配。
    // 僅負責分配規則；實際效果仍由各 skillBuff Handler 執行。
    const SKILL_BUFF_DEFAULTS = Object.freeze({
        general: {amount: 10, types: ['meal']},
        sexual: {amount: 20, types: ['erotic_drink']},
        academic: {amount: 15, items: ['mushroom', 'truffle']}
    });
    function matchSkillBuffFood(group, food, id, type) {
        const rule = SKILL_BUFF_DEFAULTS[group];
        return !!rule && (rule.types?.includes(type) || rule.items?.includes(id));
    }
    // 只回傳尚未到期的 Buff；不修改原版技能與存檔。
    function buffState(vars=state()) {
        const now=Number(vars?.timeStamp);
        const saved=obj(vars?.[BUFF_KEY]) ? vars[BUFF_KEY] : {};
        const entries={};
        for(const [group, def] of Object.entries(BUFF_GROUPS)) {
            const item=saved[group];
            const percent=Number(item?.percent), until=Number(item?.until);
            if(Number.isFinite(now)&&Number.isFinite(percent)&&percent>0&&Number.isFinite(until)&&until>now)
                entries[group]={label:def.label,percent,until,remaining:until-now};
        }
        return entries;
    }
    // 飽食階段只讀取當前未消化量，不寫入限時 Buff 存檔。
    // 階段效果共用已註冊的技能 Handler ID；不呼叫其 apply()，避免寫入 30 分鐘計時器。
    const SATIETY_KEY = 'foodEffectsSatietyBuffStages';
    const SATIETY_STAGES = Object.freeze([
        {id:'low', label:'25%～未滿 50%', min:25, defaults:{skillBuffPhysique:5,skillBuffWillpower:5}},
        {id:'mid', label:'50%～未滿 75%', min:50, defaults:{skillBuffPhysique:10,skillBuffWillpower:10}},
        {id:'high',label:'75%～100%', min:75, defaults:{skillBuffPhysique:15,skillBuffWillpower:15}}
    ]);
    function satietyStage(vars=state()) {
        const intake=intakeState(vars);
        if(!intake.valid) return null;
        const percentage=Math.max(0,Math.min(100,intake.fullness/INTAKE.capacity*100));
        return [...SATIETY_STAGES].reverse().find(stage=>percentage>=stage.min) || null;
    }
    function satietyEffects(stage, vars=state()) {
        if(!stage) return {};
        const saved=vars?.[SATIETY_KEY]?.[stage.id];
        const result={...stage.defaults};
        if(obj(saved)) for(const [key,value] of Object.entries(saved)) {
            if(!/^skillBuff(?:Physique|Willpower|General|Sexual|Academic)$/.test(key) || !getHandler(key)) continue;
            const amount=Number(value);
            if(Number.isFinite(amount)&&amount>=0&&amount<=10000) result[key]=amount;
        }
        return result;
    }
    function satietyBuffPercent(skill,vars=state()) {
        const group=BUFF_SKILL_GROUP.get(skill);
        if(!group) return 0;
        const key='skillBuff'+group[0].toUpperCase()+group.slice(1);
        return satietyEffects(satietyStage(vars),vars)[key] || 0;
    }
    // 食物與飽食來源加法疊加；同一食物群組仍只保留最高強度並延長期限。
    function getBuffPercent(skill) {
        const group=BUFF_SKILL_GROUP.get(skill);
        return group ? (buffState()[group]?.percent || 0)+satietyBuffPercent(skill) : 0;
    }
    // 延長方式：原剩餘時間 + 消化時間的一半；倍率取既有與新值的較大者。
    function grantSkillBuff(group, percent, durationSeconds=foodBuffDurationSeconds()) {
        const vars=state(), now=Number(vars?.timeStamp);
        percent=Number(percent); durationSeconds=Number(durationSeconds);
        if(!BUFF_GROUPS[group] || !Number.isFinite(now) || !Number.isFinite(percent) || percent<=0 || percent>10000 ||
           !Number.isFinite(durationSeconds) || durationSeconds<=0)
            throw new RangeError('Invalid food skill buff parameters');
        const active=buffState(vars)[group];
        // 重複食用：強度不相加，取較強者；剩餘時間加上新持續時間。
        const next={... (obj(vars[BUFF_KEY]) ? vars[BUFF_KEY] : {})};
        next[group]={percent:Math.max(active?.percent || 0,percent),until:(active?.until || now)+durationSeconds};
        vars[BUFF_KEY]=next;
        return next[group];
    }
    // 同一個全域入口，原版函式先計算裝備等修正，最後追加食物倍率。
    // disableModifiers 非零屬於內部／原始值計算，避免巢狀呼叫重複套用。
    // 包裝 currentSkillValue；disableModifiers 非 0 時跳過加成以防重複計算。
    function installSkillBuffHook() {
        const current=window.currentSkillValue;
        if(typeof current!=='function') return false;
        if(current.__foodEffectsBuffHook) return true;
        function wrapped(skill, disableModifiers=0) {
            const value=current.apply(this,arguments);
            if(Number(disableModifiers)!==0 || !Number.isFinite(value)) return value;
            const percent=getBuffPercent(skill);
            return percent ? Math.floor(value*(1+percent/100)) : value;
        }
        Object.defineProperty(wrapped,'__foodEffectsBuffHook',{value:true});
        window.currentSkillValue=wrapped;
        return true;
    }
    for(const [group, def] of Object.entries(BUFF_GROUPS)) {
        registerHandler('skillBuff'+group[0].toUpperCase()+group.slice(1),{
            label:def.label+'限時增益',
            ...(SKILL_BUFF_DEFAULTS[group] ? {
                defaults: {
                    amount: SKILL_BUFF_DEFAULTS[group].amount,
                    match: (food, id, type) => matchSkillBuffFood(group, food, id, type)
                }
            } : {}),
            canApply(){return true;},
            apply(ctx,effect){
                const result=grantSkillBuff(group,effect.amount);
                return {message:""};
            },
            describe(ctx,effect){return `${def.label} +${effect.amount}%（${digestionMinutes()/2} 分鐘，可延長）`;},
            help:'每 1 點代表此類技能有效值 +1%。每次持續目前消化時間的一半；重複食用不疊加強度，只延長時間（較強效果會取代較弱強度）。不修改原始技能值。'
        });
    }
    // 初始化與 passage 切換時保底安裝；函式可能由其他模組較晚建立。
    if(typeof document!=='undefined') {
        if(window.jQuery) window.jQuery(document).on(':passagestart',installSkillBuffHook);
        installSkillBuffHook();
    }
    // 食物轉化預設分配：只輔助已達 10 點的轉化，不啟動新的轉化路線。
    // ==================================================================
    // 07. 轉化食物分配與轉化 Handler
    // 食物只輔助已啟動的轉化：每個方向獨立檢查當前進度 >= 10。
    // 狼/鳥=肉類；貓=海鮮(排除餌蟲)及鮮奶油；狐=水果；牛=蔬菜；天使=紅酒。
    // 轉化減少 Handler 保留但不自動分配，且不套用 10 點啟動門檻。
    // ==================================================================
    const FOOD_TRANSFORM_THRESHOLD = 10;
    const TRANSFORM_FOOD_DEFAULTS = Object.freeze({
        wolf:  {categories:['meat']},
        bird:  {categories:['meat']}, // 原版 bird = 哈比／鳥類轉化
        cat:   {categories:['seafood'], items:['cream'], exclude:['bait_worm']},
        fox:   {categories:['fruit']},
        cow:   {categories:['vegetable']},
        angel: {items:['red_wine']}
    });
    // 精確 ID 與原版 category 並用；exclude 的優先級最高。
    function matchTransformationFood(kind, food, id) {
        const rule = TRANSFORM_FOOD_DEFAULTS[kind];
        if (!rule || rule.exclude?.includes(id)) return false;
        return !!(rule.items?.includes(id) || rule.categories?.includes(food?.category));
    }
    // 原版 <<transform type delta>>：八種轉化 × 增減方向，共 16 個獨立效果。
    // 僅增加方向按食物分配；減少方向仍可手動設定，不受 10 點門檻限制。
    const TRANSFORMATIONS = Object.freeze({
        wolf:   {label: '狼化', stat: 'wolfbuild'},
        cat:    {label: '貓化', stat: 'catbuild'},
        cow:    {label: '牛化', stat: 'cowbuild'},
        bird:   {label: '哈比化', stat: 'birdbuild'},
        fox:    {label: '狐化', stat: 'foxbuild'},
        angel:  {label: '天使化', stat: 'angelbuild'},
        fallen: {label: '墮天使化', stat: 'fallenbuild'},
        demon:  {label: '惡魔化', stat: 'demonbuild'}
    });
    for (const [type, transformation] of Object.entries(TRANSFORMATIONS)) {
        for (const [suffix, direction] of [['Increase', 1], ['Decrease', -1]]) {
            const increasing = direction > 0;
            registerHandler(`${type}${suffix}`, {
                label: `${increasing ? '增加' : '減少'}${transformation.label}`,
                ...(increasing && TRANSFORM_FOOD_DEFAULTS[type] ? {
                    defaults: {amount: 1, match: (food, id) => matchTransformationFood(type, food, id)}
                } : {}),
                canApply(ctx, effect) {
                    const amount = Number(effect.amount);
                    const current = Number(ctx.state?.[transformation.stat]);
                    return Number.isFinite(amount) && amount > 0 &&
                        Number.isFinite(current) &&
                        (increasing ? current >= FOOD_TRANSFORM_THRESHOLD && current < 100 : current > 0);
                },
                apply(ctx, effect) {
                    const amount = Number(effect.amount);
                    if (!Number.isFinite(amount) || amount <= 0) return;
                    // 類型由內建白名單提供，數值先驗證再傳入原版 Widget。
                    const delta = amount * direction;
                    Wikifier.wikifyEval(`<<transform "${type}" ${delta}>>`);
                },
                describe(ctx, effect) {
                    return `${increasing ? '增加' : '減少'}${transformation.label} ${effect.amount} 點`;
                },
                help: `每設定 1 點，就向原版轉化系統傳入 ${increasing ? '+1' : '-1'} 點${transformation.label}累積量（範圍 0～100）。${increasing ? '增加效果僅在該轉化進度達 10 點時生效；' : ''}實際變化可能受原版特殊條件與其他轉化的連動影響；累積值已達${increasing ? '上限' : '下限'}時不會單獨使食物可食用。`
            });
        }
    }

    // ==================================================================
    // 08. 物品預設值、覆寫與效果描述
    // defaults 組合分類效果 + 特例 + 註冊預設；get 再套用玩家覆寫。
    // ==================================================================
    function defaultType(id) {
        const food = window.setup?.foodstuff?.[id];
        return food ? classify(id,food) : null;
    }
    // 特殊品項效果：精液不恢復疲勞，保留既有特殊設定。
    function builtInSpecial(id, effects) {
        if (id === 'bottle_of_semen') {
            delete effects.fatigueRecovery;
            effects.arousalIncrease = {amount:100};
        }
        if (id === 'baby_bottle_of_breast_milk') effects.arousalIncrease = {amount:25};
        if (id === 'poached_pear') effects.intoxication = {amount:15};
    }
    function defaults(id) {
        const food=window.setup?.foodstuff?.[id]; if (!food) return null;
        const type=classify(id,food);
        const effects=copy(TYPES[type].effects);
        builtInSpecial(id,effects);
        applyRegisteredDefaults(id,food,type,effects);
        return {id,type,enabled:true,effects};
    }
    // 讀取時組合：類型預設 → 玩家類型覆寫 → 特殊規則 → 玩家物品覆寫。
    // 所有合併均在副本上進行，不回寫原版或模組預設。
    function resolveFoodConfig(id, includeItemOverrides = true) {
        const base=defaults(id); if (!base) return null;
        const vars=state();
        const patch=includeItemOverrides && obj(vars?.[KEY]?.[id]) ? vars[KEY][id] : {};
        const type=typeof patch.type==='string'&&TYPES[patch.type]?patch.type:base.type;
        const typePatch=vars?.[TYPE_KEY]?.[type];
        const effects=copy(TYPES[type].effects);
        applyRegisteredDefaults(id,window.setup.foodstuff[id],type,effects);
        mergeEffects(effects,typePatch?.effects);
        builtInSpecial(id,effects);
        mergeEffects(effects,patch.effects);
        const enabled=typeof patch.enabled==='boolean'?patch.enabled:true;
        const rawCost=Number(patch.intakeCost ?? typePatch?.intakeCost ?? INTAKE.costs[type]);
        const intakeCost=Number.isFinite(rawCost)?Math.max(0,Math.min(INTAKE.capacity,rawCost)):INTAKE.costs[type];
        return {id,type,enabled,effects,intakeCost};
    }
    // 與「沒有個別覆寫」時的實際配置比較；類型覆寫仍視為繼承設定。
    // 曾經編輯但最後恢復相同結果的項目不標記，避免留下無意義的提示。
    function isFoodCustomized(id, currentConfig) {
        const inherited = resolveFoodConfig(id, false);
        if (!inherited || !currentConfig) return false;
        if (currentConfig.type !== inherited.type ||
            currentConfig.enabled !== inherited.enabled ||
            currentConfig.intakeCost !== inherited.intakeCost) return true;
        const currentEffects = currentConfig.effects || {};
        const inheritedEffects = inherited.effects || {};
        const keys = new Set([...Object.keys(currentEffects), ...Object.keys(inheritedEffects)]);
        return [...keys].some(key => Number(currentEffects[key]?.amount ?? 0) !== Number(inheritedEffects[key]?.amount ?? 0));
    }
    // 類型自訂標記以「目前生效的類型設定」和「未覆寫的類型預設」比較。
    // 不因曾經儲存過相同設定而標記，也不影響個別食物的自訂判斷。
    function isTypeCustomized(type) {
        if (!TYPES[type]) return false;
        const patch = state()?.[TYPE_KEY]?.[type];
        if (!obj(patch)) return false;
        const baseEffects = copy(TYPES[type].effects);
        applyRegisteredDefaults(null, null, type, baseEffects);
        const effectiveEffects = copy(baseEffects);
        mergeEffects(effectiveEffects, patch.effects);
        const baseCost = INTAKE.costs[type];
        const rawCost = Number(patch.intakeCost ?? baseCost);
        const effectiveCost = Number.isFinite(rawCost)
            ? Math.max(0, Math.min(INTAKE.capacity, rawCost)) : baseCost;
        if (effectiveCost !== baseCost) return true;
        const keys = new Set([...Object.keys(baseEffects), ...Object.keys(effectiveEffects)]);
        return [...keys].some(key =>
            Number(baseEffects[key]?.amount ?? 0) !== Number(effectiveEffects[key]?.amount ?? 0));
    }
    function get(id) {
        return resolveFoodConfig(id, true);
    }
    function savePatch(key, id, patch) {
        const vars=state(); if (!vars) return false;
        const collection=obj(vars[key])?copy(vars[key]):{};
        if (patch===null) delete collection[id];
        else collection[id]=copy(patch);
        vars[key]=collection;
        return true;
    }
    // 基礎效果的資訊顯示分級：[中量起點, 大量起點]。
    // 原則：一般狀態約 1% 起為中量、5% 起為大量；倍率效果以基礎值近似分級。
    // 不使用通用預設門檻，避免不同數值尺度的效果被錯誤標為「大量」。
    // 依正常屬性上限分級：未達 10% 為少量，10%～未滿 20% 為中量，20% 以上為大量。
    // 5% 為少量的參考強度；創傷採最低基礎倍率 1.5 倍估算，實際效果可能較高。
    const BASE_EFFECT_THRESHOLDS = Object.freeze({
        fatigueRecovery: [10, 20],
        stressRelief: [13, 25],
        stressIncrease: [25, 50],
        traumaRelief: [334, 667],
        intoxication: [100, 200],
        arousalIncrease: [1000, 2000]
    });
    function describe(effect){
        const handler=getHandler(effect[0]),amount=effect[1]?.amount;
        if(!handler||!Number.isFinite(amount)||amount<=0)return '';
        if (typeof handler.describe === 'function') {
            try { return String(handler.describe(handlerContext(null, null, null, null), effect[1]) || ''); }
            catch (error) { console.warn('[More Useful Foodstuff] Handler description failed', error); return handler.label; }
        }
        // 六種基礎效果各自設定「中量／大量」的顯示門檻；僅影響資訊文字，不改變實際效果。
        const threshold = BASE_EFFECT_THRESHOLDS[effect[0]];
        if (!threshold) return handler.label;
        const level = amount >= threshold[1] ? '大量' : amount >= threshold[0] ? '中量' : '少量';
        return handler.label + level;
    }
    // 食用資格只供 evaluate 使用，與資訊介面的顯示規則互不依賴。
    function handlerEligible(key, value, id, config, before) {
        const handler = getHandler(key);
        if (!handler || !Number.isFinite(value?.amount) || value.amount <= 0) return false;
        if (typeof handler.canApply !== 'function') return true;
        return !!handler.canApply(handlerContext(id, config, before, null), value);
    }
    // ⓘ 資訊介面專用：只過濾轉化增加效果，不呼叫 Handler.canApply。
    // 直接讀取原版 State.variables 的轉化累積值；snapshot 僅包含一般狀態，
    // 不含 wolfbuild 等轉化欄位，因此不能用 snapshot 判斷顯示門檻。
    function shouldDisplayFoodEffect(key) {
        const match = /^(wolf|cat|cow|bird|fox|angel|fallen|demon)Increase$/.exec(key);
        if (!match) return true;
        const stat = TRANSFORMATIONS[match[1]]?.stat;
        const current = Number(stat ? state()?.[stat] : NaN);
        return Number.isFinite(current) && current >= FOOD_TRANSFORM_THRESHOLD && current < 100;
    }
    // 食物詳情只顯示符合轉化門檻的項目；效果設定介面不套用此過濾。
    function visibleFoodEffects(id, config) {
        return Object.entries(config.effects).filter(([key]) => shouldDisplayFoodEffect(key));
    }
    function inventory(){
        const inv=state()?.foodstuff||{},defs=window.setup?.foodstuff||{};
        return Object.keys(defs).filter(id=>Number(inv[id]?.amount)>0).map(id=>({id,amount:inv[id].amount,definition:defs[id],config:get(id)})).filter(x=>x.config?.enabled);
    }
    // ==================================================================
    // 09. 攝取狀態、食用資格與執行流程
    // evaluate 判斷是否可食用；eat 才真正消耗物品並執行 Handler。
    // 攝取容量與消化顯示、原版數值刷新彼此獨立。
    // ==================================================================
    const STATUS = Object.freeze({
        tiredness: {label: '疲勞', max: v => 2000},
        stress: {label: '壓力', max: v => v.stressmax},
        trauma: {label: '創傷', max: v => v.traumamax},
        arousal: {label: '興奮', max: v => v.arousalmax},
        drunk: {label: '醉酒', max: v => v.drunkmax}
    });
    function snapshot(vars) {
        const result = {};
        for (const [key, definition] of Object.entries(STATUS)) {
            const value = Number(vars[key]);
            const maximum = Number(definition.max(vars));
            if (Number.isFinite(value) && Number.isFinite(maximum) && maximum > 0) {
                result[key] = {value, max: maximum};
            }
        }
        return result;
    }

    // 以原版 timeStamp（秒）計算滾動攝取限制與線性消化視覺進度。
    function intakeState(vars = state()) {
        const now = Number(vars?.timeStamp);
        if (!Number.isFinite(now)) return {valid:false, used:0, fullness:0, remaining:0, active:[], nextRecovery:0};
        const history = Array.isArray(vars?.[INTAKE_KEY]) ? vars[INTAKE_KEY] : [];
        // 忽略時間回退造成的未來紀錄，避免永久占用額度。
        const active = history.filter(entry => Number.isFinite(entry?.time) && Number.isFinite(entry?.cost)
            && entry.cost > 0 && entry.time <= now && now - entry.time < digestionSeconds(vars));
        const used = active.reduce((sum, entry) => sum + entry.cost, 0);
        // 飽食視覺值線性下降，實際攝取額度仍需滿設定的消化時間才歸還。
        const fullness = active.reduce((sum, entry) =>
            sum + entry.cost * (1 - (now - entry.time) / digestionSeconds(vars)), 0);
        const nextRecovery = active.length ? Math.min(...active.map(entry => entry.time + digestionSeconds(vars) - now)) : 0;
        return {valid:true, now, used, fullness:Math.max(0, fullness), remaining:Math.max(0, INTAKE.capacity-used), active, nextRecovery};
    }
    function waitForCapacity(intake, cost) {
        if (intake.remaining >= cost) return 0;
        let used = intake.used;
        for (const entry of [...intake.active].sort((a,b)=>a.time-b.time)) {
            used -= entry.cost;
            if (INTAKE.capacity-used >= cost) return Math.max(0, entry.time+digestionSeconds()-intake.now);
        }
        return digestionSeconds();
    }
    function naturalWait(seconds) {
        const minutes = Math.max(1, Math.ceil(seconds / 60));
        if (minutes <= 5) return '再過幾分鐘';
        if (minutes < 15) return `再過十來分鐘`;
        if (minutes < 25) return '再過二十分鐘左右';
        if (minutes < 40) return '再過半個小時左右';
        if (minutes < 55) return '再過將近一個小時';
        return '再過一個小時左右';
    }
    function intakeReason(intake, cost, id) {
        if (!intake.valid) return '你一時弄不清現在過了多久，還是稍後再試吧。';
        const name = displayName(id);
        const seconds = waitForCapacity(intake, cost);
        const intro = cost >= 35
            ? `你摸了摸肚子，現在實在吃不下這麼多東西了。`
            : cost <= 15
                ? `你覺得肚子裡已經沒什麼空間，暫時連這點東西也吃不下。`
                : `你覺得肚子已經有點撐，現在還吃不下這份${name}。`;
        return `${intro}你覺得至少要${naturalWait(seconds)}，才能再吃下${name}。`;
    }
    function successfulNarrative(id, effects) {
        const name = displayName(id);
        const type = get(id)?.type;
        const action = ['drink', 'erotic_drink', 'alcohol'].includes(type) ? '喝下' : '吃下';
        const keys = new Set(effects.map(([key]) => key));
        const sensations = [];
        if (keys.has('fatigueRecovery')) sensations.push('感覺恢復了些精神');
        if (keys.has('stressRelief')) sensations.push('緊繃的心情稍微放鬆了');
        if (keys.has('traumaRelief')) sensations.push('心裡似乎舒服了一點');
        if (keys.has('intoxication')) sensations.push('感到一陣酒意湧上來');
        if (keys.has('arousalIncrease')) sensations.push('身體漸漸有些燥熱');
        if (keys.has('stressIncrease')) sensations.push('卻覺得有點不舒服');
        return `你${action}了${name}${sensations.length ? '，' + sensations.join('，') : ''}。`;
    }
    // 統一食用前檢查：庫存、狀態上下限、醉酒限制及攝取容量。
    function evaluate(id) {
        const vars = state();
        const config = get(id);
        const item = vars?.foodstuff?.[id];
        if (!config?.enabled || !item || !Number.isFinite(Number(item.amount)) || Number(item.amount) < 1) {
            return {ok: false, message: '你翻了翻背包，發現已經沒有這個了，或是現在無法食用。', effects: []};
        }
        if (!window.statChange || ['tiredness', 'stress', 'trauma', 'drunk', 'arousal'].some(key => typeof statChange[key] !== 'function')) {
            return {ok: false, message: '原版狀態函式尚未準備完成', effects: []};
        }
        const before = snapshot(vars);
        const effects = [];
        for (const [key, value] of Object.entries(config.effects)) {
            const handler = getHandler(key);
            if (!handler || !Number.isFinite(value?.amount) || value.amount <= 0) continue;
            const rule = handler.rule || EFFECT_STAT[key];
            const current = rule ? before[rule.stat] : null;
            if (rule && !current)
                return {ok: false, message: '無法讀取狀態上限：' + rule.stat, effects: []};
            const full = rule && (rule.direction > 0
                ? current.value >= current.max : current.value <= 0);
            if (full && rule.hardStop)
                return {ok: false, message: '你已經醉得分不清東南西北，實在沒辦法再喝下去了。', effects: []};
            if (full) continue;
            try {
                if (!handlerEligible(key, value, id, config, before)) continue;
            } catch (error) {
                console.error('[More Useful Foodstuff] Handler eligibility failed', key, error);
                return {ok: false, message: '食用條件判斷發生錯誤。', effects: []};
            }
            effects.push([key, value]);
        }
        if (!effects.length) {
            return {ok: false, message: '你現在似乎不需要再吃這個了，身體已經沒有更多改善的餘地。', effects: []};
        }
        const intake = intakeState(vars);
        const cost = config.intakeCost;
        if (!intake.valid || intake.remaining < cost) return {ok:false, message:intakeReason(intake,cost,id), effects:[]};
        return {ok: true, effects, before, item, intake, cost};
    }

    // 重新渲染原版側邊欄狀態，不切換 Passage，也不重繪整個 StoryCaption。
    function refreshVanillaStats() {
        const target = document.getElementById("stats");
        if (!target || !window.Wikifier?.wikifyEval) return;

        try {
            Wikifier.wikifyEval("<<replace #stats>><<statsCaption>><</replace>>");
        } catch (error) {
            console.warn("[More Useful Foodstuff] Failed to refresh vanilla stats", error);
        }
    }

    /**
     * 更新原版行動版精簡狀態圖示，不重新建立整個側邊欄。
     * 只處理原版狀態圖示；Maplebirch 與其他模組插入的節點
     * 保留在原本的 DOM 元素上。
     */
    function refreshVanillaMobileStats() {
        // 原版 StoryCaption 使用「mobileStats」；也接受「mobilStats」，
        // 以相容修改過容器名稱的遊戲環境。
        const target = document.getElementById("mobileStats")
            || document.getElementById("mobilStats");
        if (!target || typeof window.Wikifier !== "function") return;

        const glyphs = new Set(["痛", "欲", "疲", "壓", "压", "純", "纯", "創", "创", "控", "誘", "诱", "醉", "麻", "幻"]);
        const isVanillaStat = element => {
            if (!element.classList?.contains("stat")) return false;
            const tooltip = element.querySelector(":scope > mouse.tooltip-centertop");
            if (!tooltip) return false;
            const firstText = [...tooltip.childNodes].find(node => node.nodeType === 3);
            return glyphs.has(firstText?.textContent?.trim());
        };

        try {
            const rendered = document.createElement("div");
            new Wikifier(rendered, "<<mobileStats>>");
            const incoming = [...rendered.children].filter(isVanillaStat);
            const existing = [...target.children].filter(isVanillaStat);
            // 保留原本的插入位置，避免移動附近由其他模組加入的圖示。
            const anchor = existing[0] || null;
            for (const node of incoming) target.insertBefore(node, anchor);
            for (const node of existing) node.remove();
        } catch (error) {
            console.warn("[More Useful Foodstuff] Failed to refresh compact stats", error);
        }
    }

    function eat(id) {
        const check = evaluate(id);
        if (!check.ok) return check;
        const vars = state();
        // 每次點擊都重新檢查，不沿用可能已過期的介面判斷結果。
        const originalAmount = Number(check.item.amount);
        check.item.amount = originalAmount - 1;
        const extraMessages = [];
        try {
            for (const [key, value] of check.effects) {
                const handler = getHandler(key);
                const ctx = handlerContext(id, get(id), check.before, check.intake);
                const outcome = CUSTOM_HANDLERS.has(key)
                    ? handler.apply(ctx, value)
                    : handler.apply(value.amount);
                if (outcome?.message) extraMessages.push(String(outcome.message));
            }
        } catch (error) {
            check.item.amount = originalAmount;
            console.error('[FoodEffects] Effect failed', error);
            return {ok: false, message: '效果執行失敗，已退還食物（先前效果可能已生效）'};
        }
        vars[INTAKE_KEY] = [...check.intake.active, {time:check.intake.now,cost:check.cost,id}];
        const after = snapshot(vars);
        // 狀態值更新後，同步原版 UI；模組自己的動畫仍使用前後快照。
        refreshVanillaStats();
        refreshVanillaMobileStats();
        const changes = Object.keys(STATUS).filter(key => check.before[key] && after[key]
            && check.before[key].value !== after[key].value).map(key => ({
                key,
                label: STATUS[key].label,
                before: check.before[key],
                after: after[key]
            }));
        return {
            ok: true,
            message: [successfulNarrative(id, check.effects), ...extraMessages].join(" "),
            changes, effects: check.effects.map(([key,value])=>({key,description:describe([key,value])})), name:displayName(id)
        };
    }
    function displayName(id){const f=window.setup?.foodstuff?.[id];return f?.singular||f?.name||id;}
    // 角色頁面顯示：只修改 Characteristics 建立的暫時設定物件，
    // 不修改技能存檔、經驗進度或 currentSkillValue() 的實際計算。
    // ==================================================================
    // 10. Characteristics 顯示相容入口
    // 此函數供既有 TweeReplacer 補丁呼叫；不取代技能實際計算掛鉤。
    // ==================================================================
    function applyDisplayBuff(config, skill) {
        if (!config || !Number.isFinite(config.modifier)) return config;
        const percent = getBuffPercent(skill);
        if (!(percent > 0)) return config;
        // 防止相同設定物件在同一次顯示流程中重複乘算。
        if (config.__foodEffectsDisplayApplied) return config;
        Object.defineProperty(config, '__foodEffectsDisplayApplied', {
            value: true, configurable: true
        });
        // 顯示端採四捨五入，避免原版 modifier 非整百時向下取整，讓 16% 顯示成 15%。
        // 實際技能結算仍由 currentSkillValue() 處理，不受此顯示修正影響。
        config.modifier = Math.round(config.modifier * (1 + percent / 100));
        config.modTypes ??= {good: [], bad: []};
        config.modTypes.good ??= [];
        const label = `食物增益 +${percent}%`;
        if (!config.modTypes.good.includes(label)) config.modTypes.good.push(label);
        return config;
    }

    // Characteristics 由 TweeReplacer 在遊戲編譯前修改；不再攔截 SugarCube Macro。
    // 保留舊方法名稱供外部呼叫，但無須在執行期安裝任何 Hook。
    function installCharacteristicsDisplayPatch() { return true; }

    // ==================================================================
    // 11. 公開 API 與 UI
    // 公開方法與鍵名保持不變；UI 僅讀取/操作 Core 提供的 API。
    // ==================================================================
    const api={types:TYPES,handlers:HANDLERS,registerHandler,unregisterHandler,getHandler,defaults,get,inventory,eat,evaluate,describe,displayName,intakeState,intakeConfig:INTAKE,savePatch,buffGroups:BUFF_GROUPS,buffState,satietyStage,satietyEffects,satietyBuffPercent,getBuffPercent,grantSkillBuff,installSkillBuffHook,applyDisplayBuff,installCharacteristicsDisplayPatch};
    window.setup??={};setup.FoodEffectsExpanded=api;
    const UI_ID = "dfe-overlay";
    const TYPE_ICONS = Object.freeze({
        meal: "🍲",
        snack: "🍪",
        fruit: "🍎",
        dessert: "🍰",
        drink: "🥛",
        erotic_drink: "🍼",
        alcohol: "🍷",
        non_food: "📦"
    });

    function close() {
        document.getElementById(UI_ID)?.remove();
    }

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // 背包介面：食物格子、設定編輯器、狀態條及食用回饋。
    // 介面內部函數仍保留原本的閉包狀態，避免改變事件生命週期。
    function open() {
        close();

        const overlay = make("div", "dfe-overlay");
        overlay.id = UI_ID;

        const panel = make("section", "dfe-panel");
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-label", "食物背包");

        const head = make("header", "dfe-head");
        const title = make("strong", "", "食物背包");
        const x = make("button", "dfe-close", "×");
        x.type = "button";
        x.setAttribute("aria-label", "關閉");
        x.addEventListener("click", close);
        head.append(title, x);

        const tabs = make("nav", "dfe-tabs");
        tabs.setAttribute("aria-label", "食物類型");
        const body = make("div", "dfe-body");
        const statusBars = make("div", "dfe-status-bars");
        const statusTabs = make("nav", "dfe-status-tabs");
        statusTabs.setAttribute("aria-label", "狀態分類");
        const statusBuffs = make("div", "dfe-status-buffs");
        const statusGrid = make("div", "dfe-status-grid");
        const intakeSummary = make("div", "dfe-intake-summary");
        statusBars.append(statusGrid, intakeSummary);
        const message = make("p", "dfe-message");
        const editorHost = make("div", "dfe-editor-host");
        message.setAttribute("aria-live", "polite");

        // 庫存清單與食用回饋分開捲動；回饋過多時限制底部區塊高度。
        const inventorySection = make("section", "dfe-inventory-section");
        inventorySection.setAttribute("aria-label", "食物庫存");
        inventorySection.append(tabs, body);
        const feedbackSection = make("section", "dfe-feedback-section");
        feedbackSection.setAttribute("aria-label", "食用訊息");
        feedbackSection.append(message);
        panel.append(head, statusTabs, statusBars, statusBuffs, inventorySection, feedbackSection, editorHost);
        overlay.append(panel);
        overlay.addEventListener("click", event => {
            if (event.target === overlay) close();
        });
        document.body.append(overlay);

        let activeType = "all";
        let activeStatusTab = "status";
        let detailsId = null;
        let editor = null;

        function renderStatusTabs() {
            statusTabs.replaceChildren();
            // 只有存在尚未到期的技能增益，才提供上方「技能增益」分頁。
            const hasActiveBuffs = Object.keys(buffState()).length > 0 || !!satietyStage();
            if (!hasActiveBuffs && activeStatusTab === "buffs") activeStatusTab = "status";
            const visibleTabs = hasActiveBuffs
                ? [["status", "狀態"], ["buffs", "技能增益"]]
                : [["status", "狀態"]];
            for (const [id, label] of visibleTabs) {
                const button = make("button", "dfe-status-tab" + (activeStatusTab === id ? " is-active" : ""), label);
                button.type = "button";
                button.setAttribute("aria-pressed", String(activeStatusTab === id));
                button.addEventListener("click", () => {
                    activeStatusTab = id;
                    renderStatus();
                });
                statusTabs.append(button);
            }
        }

        function renderBuffStatus() {
            statusBuffs.replaceChildren();
            statusBuffs.append(make('p','dfe-buff-note','食物限時增益與飽食階段增益可相加；不修改原始技能值。'));
            const stage=satietyStage();
            if(stage) {
                const stageCard=make('div','dfe-buff-card');
                stageCard.append(make('strong','',`飽食階段：${stage.label}`));
                for(const [key,amount] of Object.entries(satietyEffects(stage))) {
                    if(amount>0) stageCard.append(make('div','dfe-buff-skills',`${getHandler(key)?.label || key} +${amount}%（隨飽食變化）`));
                }
                statusBuffs.append(stageCard);
            }
            const active = buffState();
            for (const [group, buff] of Object.entries(active)) {
                const def = BUFF_GROUPS[group];
                const card = make('div','dfe-buff-card');
                const heading = make('div','dfe-buff-heading');
                heading.append(make('strong','',def.label),make('span',buff?'dfe-buff-active':'dfe-buff-inactive',buff?`+${buff.percent}%`:'未啟用'));
                card.append(heading);
                card.append(make('div','dfe-buff-time',buff?`剩餘 ${Math.ceil(buff.remaining/60)} 分鐘`:'目前沒有增益'));
                card.append(make('div','dfe-buff-skills',def.skills.join(' · ')));
                statusBuffs.append(card);
            }
        }

        function renderStatus(changes = []) {
            renderStatusTabs();
            statusBars.hidden = activeStatusTab !== "status";
            statusBuffs.hidden = activeStatusTab !== "buffs";
            if (activeStatusTab === "buffs") {
                renderBuffStatus();
                return;
            }
            const beforeByKey = new Map(changes.map(c => [c.key,c]));
            const current = snapshot(state() || {});
            statusGrid.replaceChildren();
            for (const [key, definition] of Object.entries(STATUS)) {
                const stat = current[key];
                if (!stat) continue;
                const change = beforeByKey.get(key);
                const old = change?.before || stat;
                const beforePct = Math.max(0,Math.min(100,old.value / old.max * 100));
                const afterPct = Math.max(0,Math.min(100,stat.value / stat.max * 100));
                const row = make('div','dfe-mini-status');
                const top = make('div','dfe-mini-top');
                const label = make('span','',definition.label);
                const delta = change ? stat.value-change.before.value : 0;
                const value = make('span','dfe-mini-value',`${Math.round(afterPct)}%` + (delta ? ` (${delta>0?'+':''}${Math.round(delta)})` : ''));
                if (delta) value.classList.add((key==='arousal'||key==='drunk' ? delta<0 : delta>0) ? 'dfe-negative' : 'dfe-positive');
                top.append(label,value);
                const track=make('div','dfe-status-track');
                const fill=make('div','dfe-status-fill dfe-fill-'+key);
                fill.style.width=beforePct+'%';
                track.append(fill);
                row.append(top,track);
                statusGrid.append(row);
                if (change) requestAnimationFrame(()=>requestAnimationFrame(()=>{if(fill.isConnected)fill.style.width=afterPct+'%';}));
            }
            const intake = intakeState();
            const row=make('div','dfe-mini-status dfe-intake-row');
            const top=make('div','dfe-mini-top');
            top.append(make('span','','飽食度／攝取額度'),make('span','dfe-mini-value',
                intake.valid ? `占用 ${Math.round(intake.used)} · 未消化 ${Math.round(intake.fullness)} / ${INTAKE.capacity}` : '時間未就緒'));
            const track=make('div','dfe-status-track dfe-intake-track');
            // 外層（棕色）：在目前設定的消化時間內仍被占用的攝取額度。
            // 內層（橘色）：尚未消化的部分，在相同時間窗口內線性遞減。
            const reserved=make('div','dfe-intake-reserved');
            const undigested=make('div','dfe-intake-undigested');
            const pct = value => Math.max(0,Math.min(100,value / INTAKE.capacity * 100));
            const old = renderStatus.previousIntake;
            const oldUsed = old && Number.isFinite(old.used) ? old.used : intake.used;
            const oldFullness = old && Number.isFinite(old.fullness) ? old.fullness : intake.fullness;
            reserved.style.width=pct(oldUsed)+'%';
            undigested.style.width=oldUsed>0 ? Math.max(0,Math.min(100,oldFullness/oldUsed*100))+'%' : '0%';
            reserved.append(undigested);
            track.append(reserved);row.append(top,track);statusGrid.append(row);
            renderStatus.previousIntake={used:intake.used,fullness:intake.fullness};
            requestAnimationFrame(()=>requestAnimationFrame(()=>{
                if (!reserved.isConnected) return;
                reserved.style.width=pct(intake.used)+'%';
                undigested.style.width=intake.used>0 ? Math.max(0,Math.min(100,intake.fullness/intake.used*100))+'%' : '0%';
            }));
            intakeSummary.replaceChildren();
            intakeSummary.append(make('span','dfe-intake-legend',`未消化 ${Math.round(intake.fullness)}`),
                make('span','dfe-intake-legend',`已消化但占用 ${Math.round(Math.max(0,intake.used-intake.fullness))}`),
                make('span','dfe-intake-legend',`可用 ${Math.round(intake.remaining)}`));
            if (intake.valid && intake.active.length) {
                intakeSummary.append(make('span','dfe-intake-next',`下一筆約 ${Math.ceil(intake.nextRecovery/60)} 分鐘後釋放`));
            }

        }
        function showFeedback(result) {
            message.replaceChildren();
            message.classList.toggle('dfe-message-warning',!result.ok);
            if (!result.ok) { message.textContent=result.message; return; }
            // 技能 Buff 已由下方標籤完整呈現，不再輸出重複的逐項敘述。
            // 其他效果仍保留原本的食用敘事與訊息。
            const narrative = String(result.message || '').trim();
            if (narrative) message.append(make('strong','dfe-feedback-narrative',narrative));
            const activeBuffs = buffState();
            for (const effect of result.effects || []) {
                const buffGroup = /^skillBuff(Physique|Willpower|General|Sexual|Academic)$/.exec(effect.key)?.[1]?.toLowerCase();
                if (buffGroup && BUFF_GROUPS[buffGroup]) {
                    const buff = activeBuffs[buffGroup];
                    // 以實際生效強度及剩餘遊戲時間為準，不使用食物預設的 30 分鐘。
                    const percent = buff?.percent ?? Number(getHandler(effect.key)?.defaults?.amount ?? 0);
                    const badge = make('span', 'dfe-feedback-effect dfe-effect-positive',
                        `${BUFF_GROUPS[buffGroup].label} +${percent}%`);
                    const line = make('div', 'dfe-feedback-buff-row');
                    line.append(badge);
                    if (buff) line.append(make('span', 'dfe-feedback-buff-remaining',
                        `剩餘 ${Math.ceil(buff.remaining / 60)} 分鐘`));
                    message.append(line);
                    continue;
                }
                const negative=['stressIncrease','intoxication','arousalIncrease'].includes(effect.key);
                message.append(make('span','dfe-feedback-effect '+(negative?'dfe-effect-negative':'dfe-effect-positive'),effect.description));
            }
        }

        let helpCleanup = null;
        function renderEditor() {
            helpCleanup?.();
            helpCleanup = null;
            editorHost.replaceChildren();
            if (!editor) return;
            if(editor.kind==='satiety') {
                const modal=make('div','dfe-editor-backdrop');
                const pane=make('section','dfe-editor');
                const top=make('div','dfe-editor-head');
                top.append(make('strong','','飽食階段增益設定'));
                const exit=make('button','dfe-editor-close','×');exit.type='button';exit.onclick=()=>{editor=null;renderEditor();};
                top.append(exit);pane.append(top);
                // 消化時間與飽食增益共用設定視窗，但不影響限時技能 Buff。
                const digestionRow=make('div','dfe-editor-field');
                digestionRow.append(make('span','dfe-editor-field-name','消化時間'));
                const digestionSelect=make('select','dfe-editor-input');
                for(const minutes of DIGESTION_OPTIONS) {
                    const option=make('option','',`${minutes} 分鐘${minutes===90?'（預設）':''}`);
                    option.value=String(minutes);
                    digestionSelect.append(option);
                }
                digestionSelect.value=String(digestionMinutes());
                digestionSelect.onchange=()=>{
                    const minutes=Number(digestionSelect.value);
                    if(!DIGESTION_OPTIONS.includes(minutes)) return;
                    const vars=state();
                    if(!vars) return;
                    vars[DIGESTION_KEY]=minutes;
                    render();
                    message.textContent=`消化時間已設定為 ${minutes} 分鐘。`;
                };
                digestionRow.append(digestionSelect);
                pane.append(digestionRow);
                pane.append(make('p','dfe-editor-hint','消化時間同時控制飽食度下降與攝取容量整筆釋放；變更後既有紀錄立即依新時間計算。'));
                pane.append(make('p','dfe-editor-hint','依未消化飽食度判定；只支援持續技能增益。食物限時增益與飽食增益相加，飽食來源忽略持續時間。'));
                const selector=make('select','dfe-editor-input');
                for(const stage of SATIETY_STAGES){const option=make('option','',stage.label);option.value=stage.id;selector.append(option);}
                selector.value=editor.id;
                selector.onchange=()=>openEditor('satiety',selector.value);
                pane.append(selector);
                const stage=SATIETY_STAGES.find(item=>item.id===editor.id) || SATIETY_STAGES[0];
                const current=satietyEffects(stage);
                const controls={};
                for(const group of Object.keys(BUFF_GROUPS)) {
                    const key='skillBuff'+group[0].toUpperCase()+group.slice(1);
                    if(!getHandler(key)) continue;
                    const row=make('div','dfe-editor-field');
                    row.append(make('span','dfe-editor-field-name',BUFF_GROUPS[group].label+'（%）'));
                    const input=make('input','dfe-editor-input');input.type='number';input.min='0';input.max='10000';input.step='1';input.value=String(current[key] || 0);
                    row.append(input);pane.append(row);controls[key]=input;
                }
                const actions=make('div','dfe-editor-actions');
                const reset=make('button','','還原此階段');reset.type='button';reset.onclick=()=>{
                    savePatch(SATIETY_KEY,stage.id,null);render();openEditor('satiety',stage.id);
                };
                const save=make('button','dfe-editor-save','儲存設定');save.type='button';save.onclick=()=>{
                    const values={};
                    for(const [key,input] of Object.entries(controls)) {
                        const n=Number(input.value);
                        if(!input.value.trim() || !Number.isFinite(n)||n<0||n>10000) {message.textContent='增益需介於 0～10000%。';return;}
                        values[key]=n;
                    }
                    savePatch(SATIETY_KEY,stage.id,values);render();openEditor('satiety',stage.id);
                    message.textContent='飽食階段增益已儲存。';
                };
                actions.append(reset,save);pane.append(actions);modal.append(pane);editorHost.append(modal);
                modal.onclick=e=>{if(e.target===modal){editor=null;renderEditor();}};
                return;
            }
            const isType=editor.kind==='type';
            const id=editor.id;
            const type=isType?id:get(id)?.type;
            if (!type || !TYPES[type]) { editor=null; return; }
            const vars=state() || {};
            const key=isType?TYPE_KEY:KEY;
            const stored=vars[key]?.[id];
            const draft=stored && obj(stored)?copy(stored):{};
            const effective=isType?{
                effects:(()=>{const e=copy(TYPES[type].effects);applyRegisteredDefaults(null,null,type,e);mergeEffects(e,draft.effects);return e;})(),
                intakeCost:draft.intakeCost ?? INTAKE.costs[type]
            }:get(id);
            const modal=make('div','dfe-editor-backdrop');
            const pane=make('section','dfe-editor');
            const top=make('div','dfe-editor-head');
            const editorTitle = make('strong','',isType?`類型設定：${TYPES[type].label}`:`物品設定：${displayName(id)}`);
            // 類型編輯視窗也顯示自訂狀態，不依賴玩家目前持有的食物。
            if (isType && isTypeCustomized(type)) {
                editorTitle.classList.add('dfe-type-customized');
                editorTitle.title = '此類型使用自訂設定';
            }
            top.append(editorTitle);
            const exit=make('button','dfe-editor-close','×');exit.type='button';exit.onclick=()=>{editor=null;renderEditor();};top.append(exit);pane.append(top);
            pane.append(make('p','dfe-editor-hint',isType?'這裡的設定會套用到此類所有食物；個別食物設定優先。':'未修改的項目會繼承類型設定與內建特殊規則。'));
            const form=make('div','dfe-editor-fields');
            // 將說明浮層掛在 document.body，避開設定視窗的 overflow 裁切。
            const popups=[];
            const closeHelp=()=>{
                for(const {button,popup} of popups){
                    popup.hidden=true;
                    button.setAttribute('aria-expanded','false');
                }
            };
            const positionHelp=(button,popup)=>{
                const rect=button.getBoundingClientRect();
                const margin=8;
                const width=Math.min(300,window.innerWidth-margin*2);
                popup.style.width=`${width}px`;
                popup.style.left=`${Math.max(margin,Math.min(rect.left+rect.width/2-width/2,window.innerWidth-width-margin))}px`;
                popup.style.top='0px';
                popup.style.maxHeight=`${Math.max(100,window.innerHeight-margin*2)}px`;
                const height=popup.getBoundingClientRect().height;
                const below=window.innerHeight-rect.bottom-margin;
                const above=rect.top-margin;
                const top=(below>=height || below>=above)
                    ? Math.min(rect.bottom+7,window.innerHeight-height-margin)
                    : Math.max(margin,rect.top-height-7);
                popup.style.top=`${Math.max(margin,top)}px`;
            };
            const helpButton=(lines)=>{
                const holder=make('span','dfe-help-holder');
                const button=make('button','dfe-help-button','?');
                button.type='button';button.setAttribute('aria-label','查看參數說明');button.setAttribute('aria-expanded','false');
                const popup=make('div','dfe-help-popup dfe-help-portal');
                popup.setAttribute('role','tooltip');popup.hidden=true;
                for(const line of lines) popup.append(make('span','dfe-help-line',line));
                document.body.append(popup);
                popups.push({button,popup});
                button.onclick=e=>{
                    e.stopPropagation();
                    const opening=popup.hidden;
                    closeHelp();
                    if(opening){popup.hidden=false;positionHelp(button,popup);button.setAttribute('aria-expanded','true');}
                };
                holder.append(button);return holder;
            };
            const outsideHelp=e=>{
                if(!e.target.closest?.('.dfe-help-holder, .dfe-help-portal')) closeHelp();
            };
            const repositionHelp=()=>{
                for(const {button,popup} of popups) if(!popup.hidden) positionHelp(button,popup);
            };
            document.addEventListener('click',outsideHelp);
            window.addEventListener('resize',repositionHelp);
            window.addEventListener('scroll',repositionHelp,true);
            helpCleanup=()=>{
                document.removeEventListener('click',outsideHelp);
                window.removeEventListener('resize',repositionHelp);
                window.removeEventListener('scroll',repositionHelp,true);
                for(const {popup} of popups) popup.remove();
            };
            const row=(label,control,help)=>{
                const wrapper=make('div','dfe-editor-field');
                const name=make('span','dfe-editor-field-name',label);
                if(help)name.append(helpButton(help));
                wrapper.append(name,control);form.append(wrapper);
            };
            if (isType) {
                const selector=make('select','dfe-editor-input');
                for(const [k,v] of Object.entries(TYPES)){const o=make('option','',v.label);o.value=k;selector.append(o);}
                selector.value=type;
                if (isTypeCustomized(type)) selector.classList.add('dfe-type-customized');
                // 選項本身使用文字標記，避免行動瀏覽器不支援 option 的 CSS 裝飾。
                for (const option of selector.options) {
                    if (isTypeCustomized(option.value)) option.textContent = `${TYPES[option.value].label} · 已自訂`;
                }
                selector.onchange=()=>openEditor('type',selector.value);row('選擇要編輯的類型',selector);
            }
            if (!isType) {
                const select=make('select','dfe-editor-input');
                for(const [k,v] of Object.entries(TYPES)) {const opt=make('option','',v.label);opt.value=k;select.append(opt);}
                select.value=effective.type;
                select.onchange=()=>{draft.type=select.value;savePatch(KEY,id,draft);render();renderEditor();};
                row('食物分類（更改後立即套用新類型）',select);
                const enabled=make('input');enabled.type='checkbox';enabled.checked=effective.enabled;
                enabled.onchange=()=>{draft.enabled=enabled.checked;savePatch(KEY,id,draft);render();renderEditor();};
                row('允許食用',enabled);
            }
            const cost=make('input','dfe-editor-input');cost.type='number';cost.min='0';cost.max=String(INTAKE.capacity);cost.step='1';cost.value=String(effective.intakeCost);
            row('飽食容量占用（0～100）',cost,INTAKE_HELP);
            const effects=make('div','dfe-editor-effects');
            effects.setAttribute('role','region');
            effects.setAttribute('aria-label','食用效果設定（可捲動）');
            effects.tabIndex=0;
            const effectControls={};
            for(const [effectKey,handler] of handlerEntries()) {
                const effect=effective.effects?.[effectKey];
                const erow=make('div','dfe-editor-effect');
                const toggle=make('input');toggle.type='checkbox';toggle.checked=!!effect && effect.amount>0;
                const amount=make('input','dfe-editor-input');amount.type='number';amount.min='0';amount.max='10000';amount.step='1';amount.value=String(effect?.amount ?? TYPES[type].effects[effectKey]?.amount ?? handler.defaults?.amount ?? 1);
                amount.disabled=!toggle.checked;
                toggle.onchange=()=>{amount.disabled=!toggle.checked;};
                const name=make('span','dfe-editor-effect-name',handler.label);
                const help=PARAM_HELP[effectKey] || (handler.help ? [String(handler.help)] : ['自訂效果：實際數值換算由此效果的 Handler 決定。']);
                name.append(helpButton(help));
                erow.append(toggle,name,amount);effects.append(erow);
                effectControls[effectKey]={toggle,amount};
            }
            form.append(make('strong','','食用效果（數值由對應效果處理）'),effects);
            pane.append(form);
            const actions=make('div','dfe-editor-actions');
            const reset=make('button','','還原預設');reset.type='button';reset.onclick=()=>{savePatch(key,id,null);editor=null;render();renderEditor();message.textContent='已還原預設設定。';};
            const save=make('button','dfe-editor-save','儲存設定');save.type='button';save.onclick=()=>{
                const raw=Number(cost.value);
                if(!Number.isFinite(raw)||raw<0||raw>INTAKE.capacity){message.textContent='飽食占用必須介於 0～100。';return;}
                draft.intakeCost=raw;
                draft.effects={};
                for(const [effectKey,control] of Object.entries(effectControls)) {
                    if(!control.toggle.checked){draft.effects[effectKey]=null;continue;}
                    const n=Number(control.amount.value);
                    if(!Number.isFinite(n)||n<=0||n>10000){message.textContent=`${getHandler(effectKey).label} 必須大於 0 且不超過 10000。`;return;}
                    draft.effects[effectKey]={amount:n};
                }
                savePatch(key,id,draft);editor=null;render();renderEditor();message.textContent='食物設定已儲存。';
            };
            actions.append(reset,save);pane.append(actions);modal.append(pane);editorHost.append(modal);
            modal.onclick=e=>{if(e.target===modal){editor=null;renderEditor();}};
        }
        function openEditor(kind,id){editor={kind,id};renderEditor();}
        function render() {
            renderStatus();
            const items = inventory();
            const grouped = new Map(Object.keys(TYPES).map(type => [type, []]));

            for (const item of items) {
                if (!grouped.has(item.config.type)) grouped.set(item.config.type, []);
                grouped.get(item.config.type).push(item);
            }

            const availableTypes = [...grouped.keys()].filter(type => grouped.get(type).length);
            if (activeType !== "all" && !availableTypes.includes(activeType)) activeType = "all";

            tabs.replaceChildren();
            const satietySettings=make('button','dfe-tab','⚙ 飽食增益');
            satietySettings.type='button';
            satietySettings.onclick=()=>openEditor('satiety','low');
            tabs.append(satietySettings);
            const typeSettings=make('button','dfe-tab dfe-type-settings','⚙ 類型設定');
            typeSettings.type='button';
            // 任一類型存在自訂配置時，入口也給予提示；不受背包物品限制。
            if (Object.keys(TYPES).some(isTypeCustomized)) {
                typeSettings.classList.add('dfe-type-customized');
                typeSettings.title = '已有自訂類型設定';
            }
            typeSettings.onclick=()=>openEditor('type',activeType==='all'?'meal':activeType);
            tabs.append(typeSettings);
            const tabDefs = [
                ["all", "全部", items.length],
                ...availableTypes.map(type => [type, TYPES[type]?.label || type, grouped.get(type).length])
            ];

            for (const [type, label, count] of tabDefs) {
                const tab = make("button", "dfe-tab" + (type === activeType ? " is-active" : ""), count == null ? label : `${label} (${count})`);
                tab.type = "button";
                // 類別分頁與食物卡片使用相同的自訂提示樣式。
                if (type !== "all" && isTypeCustomized(type)) {
                    tab.classList.add('dfe-type-customized');
                    tab.title = '此類型使用自訂設定';
                }
                tab.setAttribute("aria-pressed", String(type === activeType));
                tab.addEventListener("click", () => {
                    activeType = type;
                    detailsId = null;
                    render();
                });
                tabs.append(tab);
            }

            body.replaceChildren();
            if (!items.length) {
                body.append(make("p", "dfe-empty", "目前沒有可食用的物品。"));
                return;
            }

            const typesToShow = activeType === "all" ? availableTypes : [activeType];

            for (const type of typesToShow) {
                const typeItems = grouped.get(type) || [];
                if (!typeItems.length) continue;

                const section = make("section", "dfe-section");
                const heading = make("h3", "dfe-section-title", `${TYPE_ICONS[type] || "🍴"} ${TYPES[type]?.label || type} (${typeItems.length})`);
                if (isTypeCustomized(type)) {
                    heading.classList.add('dfe-type-customized');
                    heading.title = '此類型使用自訂設定';
                }
                const grid = make("div", "dfe-grid");

                for (const item of typeItems) {
                    const card = make("article", "dfe-card");
                    // 僅在個別食物的有效設定偏離繼承預設時，顯示低調的左側細線。
                    if (isFoodCustomized(item.id, item.config)) {
                        card.classList.add('dfe-card-customized');
                        card.title = '此食物使用自訂設定';
                    }
                    const icon = make("span", "dfe-food-icon");
                    icon.setAttribute("aria-hidden", "true");
                    // 沿用原版 <<foodstufficon>> Widget，讀取
                    // setup.foodstuff[id].icon，並交由遊戲的 <<icon>> 解析器處理。
                    try {
                        if (typeof window.Wikifier !== "function") {
                            throw new Error("SugarCube Wikifier is unavailable");
                        }
                        new Wikifier(icon, `<<foodstufficon ${JSON.stringify(item.id)}>>`);
                    } catch (error) {
                        console.warn("[FoodEffects] Vanilla food icon failed:", item.id, error);
                        icon.textContent = "🍴";
                    }

                    // 食物名稱即為食用操作；不可食用時禁用名稱，但保留設定與詳情按鈕。
                    const name = make("button", "dfe-food-name dfe-food-eat-name", displayName(item.id));
                    name.type = "button";
                    name.title = `食用${displayName(item.id)}`;
                    name.setAttribute("aria-label", name.title);
                    const amount = make("div", "dfe-count", `×${item.amount}`);

                    const actions = make("div", "dfe-card-actions");
                    const info = make("button", "dfe-info-btn", "ℹ️");
                    info.type = "button";
                    info.title = `查看${displayName(item.id)}詳情`;
                    info.setAttribute("aria-label", info.title);
                    info.setAttribute("aria-expanded", String(detailsId === item.id));
                    info.addEventListener("click", () => {
                        detailsId = detailsId === item.id ? null : item.id;
                        render();
                    });

                    const eligibility = evaluate(item.id);
                    if (!eligibility.ok) {
                        card.classList.add('dfe-card-unavailable');
                        name.disabled = true;
                        name.title = eligibility.message;
                    } else {
                        name.addEventListener("click", () => {
                            const result = eat(item.id);
                            if (result.ok) detailsId = null;
                            render();
                            if (result.ok) renderStatus(result.changes);
                            showFeedback(result);
                        });
                    }
                    const gear=make('button','dfe-gear-btn','⚙');
                    gear.type='button';gear.title=`設定${displayName(item.id)}的分類與效果`;
                    gear.setAttribute('aria-label',gear.title);
                    gear.onclick=()=>openEditor('item',item.id);
                    actions.append(gear,info);
                    if (!eligibility.ok) {
                        // 問號緊鄰詳情按鈕；點擊只顯示無法食用的原因，不執行食用。
                        const reason = make('button','dfe-unavailable-reason','?');
                        reason.type='button';
                        reason.title=eligibility.message;
                        reason.setAttribute('aria-label',`無法食用${displayName(item.id)}：${eligibility.message}`);
                        reason.addEventListener('click', () => {
                            showFeedback({ok:false,message:eligibility.message});
                        });
                        actions.append(reason);
                    }
                    card.append(icon, name, amount, actions);
                    grid.append(card);

                    if (detailsId === item.id) {
                        const details = make("div", "dfe-details");
                        details.append(make("strong", "", displayName(item.id)));
                        details.append(make("div", "dfe-detail-meta", `類型：${TYPES[type]?.label || type} · 持有：${item.amount}`));
                        const fullnessCost = item.config.intakeCost;
                        details.append(make("div", "dfe-detail-fullness", `飽食占用：${fullnessCost} / ${INTAKE.capacity} · 60 分鐘內占用攝取額度，飽食度會逐漸下降`));

                        const descriptions = visibleFoodEffects(item.id, item.config)
                            .map(describe)
                            .filter(Boolean);
                        const effectList = make("div", "dfe-detail-effects");
                        for (const description of descriptions) {
                            effectList.append(make("span", "dfe-effect-chip", description));
                        }
                        if (!descriptions.length) {
                            effectList.append(make("span", "", "無額外效果"));
                        }
                        details.append(effectList);
                        // 詳細資訊只對應目前選取的食物，顯示於分類網格下方，
                        // 而不是插入每一張食物卡片內。
                        section.append(details);
                    }
                }

                section.insertBefore(heading, section.firstChild);
                section.insertBefore(grid, heading.nextSibling);
                body.append(section);
            }
        }

        render();
    }

    // ==================================================================
    // 12. 啟動入口與外部整合
    // 將 open/close 掛至 API；HintMobile 餐盤圖示使用 Maplebirch。
    // ==================================================================
    api.open = open;
    api.close = close;

    // 餐盤入口沿用原版 HintMobile 整合；不使用 Maplebirch 修改技能倍率。
    try {
        if (window.maplebirch?.tool?.addTo) {
            window.maplebirch.tool.addTo("HintMobile", "DFEFoodIcon");
        } else {
            console.warn("[FoodEffects] Maplebirch addTo is unavailable at registration time.");
        }
    } catch (error) {
        console.warn("[FoodEffects] HintMobile icon registration failed:", error);
    }
})();

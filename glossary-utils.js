// glossary-utils.js - Tiện ích chuẩn hoá, lọc rác và kiểm tra chất lượng Glossary
(function (global) {
    'use strict';

    const HANZI_CHAR_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
    const PURE_CHINESE_TERM_REGEX = /^[\u4e00-\u9fff\u3400-\u4dbf·・]{2,20}$/;
    const HAS_UPPERCASE_REGEX = /[A-ZÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/;
    const STARTS_LOWERCASE_REGEX = /^[a-zàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/;
    const SENTENCE_PUNCT_REGEX = /[，。！？；：、\n\r]/;

    // Danh sách từ gốc tiếng Trung là danh từ chung, chức danh, xưng hô, vật phẩm phổ thông (không phải tên riêng)
    const COMMON_ORIG_BLOCKLIST = new Set([
        // Nghề nghiệp, vai trò đời thường
        '店主', '小二', '店小二', '掌柜', '掌柜的', '伙计', '老板', '老板娘',
        '客官', '客人', '顾客', '路人', '行人', '村长', '村民', '镇长', '乡绅',
        '县令', '知府', '捕快', '衙役', '管家', '下人', '仆人', '侍卫', '护卫',
        '守卫', '侍女', '丫鬟', '奴婢', '车夫', '船夫', '铁匠', '猎户', '樵夫',
        '书生', '秀才', '举人', '状元', '大夫', '郎中', '医师', '厨师', '乞丐',
        // Mô tả nhân vật / quan hệ / xưng hô chung
        '老者', '老人', '老头', '老妇', '青年', '少年', '少女', '男子', '女子',
        '中年人', '黑衣人', '白衣人', '红衣人', '青衣人', '蒙面人', '神秘人',
        '大汉', '壮汉', '小孩', '孩童', '婴儿', '父亲', '母亲', '父母', '爷爷',
        '奶奶', '哥哥', '姐姐', '弟弟', '妹妹', '兄长', '族人', '族长', '家主',
        '夫人', '小姐', '公子', '少爷', '少主', '大小姐', '二小姐', '少奶奶',
        // Chức danh, vai vế tu tiên / giang hồ chung
        '宗主', '掌门', '门主', '阁主', '宫主', '殿主', '帮主', '庄主', '谷主',
        '岛主', '峰主', '堂主', '坛主', '舵主', '城主', '长老', '大长老', '二长老',
        '三长老', '太上长老', '外门长老', '内门长老', '护法', '弟子', '门徒',
        '记名弟子', '外门弟子', '内门弟子', '核心弟子', '真传弟子', '亲传弟子',
        '师父', '师尊', '师母', '师兄', '大师兄', '二师兄', '师姐', '大师姐',
        '师弟', '师妹', '小师妹', '师叔', '师伯', '师祖', '道友', '道兄', '道长',
        '仙子', '仙姑', '前辈', '晚辈', '后辈', '同门', '修士', '散修', '魔修',
        '妖修', '佛修', '邪修', '鬼修', '体修', '剑修', '武者', '武修', '凡人',
        '修仙者', '修真者', '炼丹师', '炼器师', '阵法师', '符师', '制符师',
        '灵植夫', '御兽师', '圣子', '圣女', '老祖', '天骄', '妖孽',
        // Triều đình / quân đội / kính ngữ chung
        '陛下', '皇上', '皇帝', '太后', '皇后', '皇子', '太子', '公主', '王爷',
        '郡主', '丞相', '宰相', '将军', '元帅', '统领', '校尉', '士兵', '士卒',
        '大臣', '文武百官', '太监', '宫女', '大人', '阁下', '在下', '本座',
        '本尊', '本王', '本宫', '本少', '贫道', '老夫', '老朽', '老衲', '施主',
        // Địa điểm, công trình chung
        '客栈', '酒楼', '茶馆', '茶楼', '青楼', '商铺', '店铺', '铺子', '药铺',
        '符铺', '坊市', '集市', '夜市', '黑市', '拍卖行', '拍卖会', '商会',
        '宗门', '门派', '家族', '世家', '皇朝', '王朝', '帝国', '王国', '村子',
        '村庄', '小镇', '城池', '皇宫', '大殿', '议事厅', '藏经阁', '藏书阁',
        '炼丹房', '炼器室', '灵田', '药园', '秘境', '禁地', '洞府', '山洞', '密室',
        // Tài nguyên, vật phẩm, cảnh giới, khái niệm tu luyện phổ thông
        '灵石', '下品灵石', '中品灵石', '上品灵石', '极品灵石', '灵晶', '元石',
        '灵气', '灵力', '真气', '真元', '内力', '元力', '法力', '灵脉', '灵根',
        '丹药', '灵丹', '丹方', '药材', '灵草', '灵药', '符箓', '灵符', '阵法',
        '阵盘', '飞剑', '灵剑', '法宝', '灵宝', '通天灵宝', '灵器', '法器', '宝物',
        '功法', '秘籍', '武技', '剑法', '刀法', '身法', '心法', '法术', '神通',
        '储物袋', '储物戒', '纳戒', '修炼', '修行', '突破', '闭关', '吐纳', '打坐',
        '引气', '炼气', '练气', '筑基', '金丹', '结丹', '元婴', '化神', '炼虚',
        '合体', '大乘', '渡劫', '飞升', '境界', '修为', '神识', '神念', '灵魂',
        '元神', '寿元', '心魔', '天劫', '雷劫', '妖兽', '灵兽', '魔兽', '凶兽',
        '鬼物', '傀儡', '尸傀', '肉身', '经脉', '丹田', '识海', '气海'
    ]);

    // Tiền tố mô tả chung (cụm mô tả cửa hàng, vật phẩm vô danh như 平价制符铺)
    const GENERIC_ORIG_PREFIXES = [
        '平价', '普通', '一般', '廉价', '无名', '未知', '某个', '某位', '某家', '这家', '那家'
    ];

    const PLACEHOLDER_LINES = new Set([
        'none', 'n/a', 'null', 'empty', 'trống', 'không có', 'không có từ mới', '(trống)', '(không có)'
    ]);

    function hasHanzi(str) {
        return HANZI_CHAR_REGEX.test(str || '');
    }

    function isPureChineseTerm(str) {
        return PURE_CHINESE_TERM_REGEX.test(str || '');
    }

    // Gỡ các dấu ngoặc sách, ngoặc kép, markdown và dấu câu thừa bao quanh thuật ngữ
    function stripGlossaryWrappers(str) {
        let s = (str || '').trim();
        if (!s) return '';

        // Gỡ markdown code/bold/italic bọc ngoài
        s = s.replace(/^[`*_]+|[`*_]+$/g, '').trim();

        const pairs = [
            ['《', '》'],
            ['〈', '〉'],
            ['「', '」'],
            ['『', '』'],
            ['【', '】'],
            ['[', ']'],
            ['(', ')'],
            ['（', '）'],
            ['"', '"'],
            ["'", "'"],
            ['“', '”'],
            ['‘', '’']
        ];

        let changed = true;
        while (changed && s.length > 0) {
            changed = false;
            for (const [open, close] of pairs) {
                if (s.startsWith(open) && s.endsWith(close) && s.length > open.length + close.length) {
                    s = s.slice(open.length, s.length - close.length).trim();
                    changed = true;
                }
            }
            // Gỡ dấu ngoặc sách / ngoặc kép bị lẻ một đầu (VD: "Hỏa Công》" hoặc "《Liệt Hỏa Công")
            const orphanStart = /^[《〈「『【“‘"']+/;
            const orphanEnd = /[》〉」』】”’"']+$/;
            const next = s.replace(orphanStart, '').replace(orphanEnd, '').trim();
            if (next !== s) {
                s = next;
                changed = true;
            }
        }

        return s.replace(/\s+/g, ' ').trim();
    }

    // Gỡ chú thích trong ngoặc ở cuối nghĩa tiếng Việt (VD: "Liệt Hỏa Công (công pháp hệ hỏa)" -> "Liệt Hỏa Công")
    function stripTrailingNote(hanviet) {
        let s = (hanviet || '').trim();
        s = s.replace(/\s*[（(][^()（）]{1,60}[）)]\s*$/, '').trim();
        return stripGlossaryWrappers(s);
    }

    // Kiểm tra xem cặp từ có phải danh từ chung / từ rác không phải tên riêng hay không
    function getNonProperNounReason(orig, hanviet) {
        if (!orig || !hanviet) return 'Thiếu từ gốc hoặc nghĩa dịch';
        if (SENTENCE_PUNCT_REGEX.test(orig)) return 'Chứa dấu câu / cả câu dài';
        if (!isPureChineseTerm(orig)) {
            if (!hasHanzi(orig)) return 'Từ gốc không phải chữ Hán';
            if (orig.length < 2) return 'Từ gốc quá ngắn (1 chữ)';
            if (orig.length > 20) return 'Từ gốc quá dài';
            return 'Từ gốc chứa ký tự lạ';
        }
        if (hasHanzi(hanviet)) return 'Nghĩa dịch vẫn chứa chữ Hán';
        if (COMMON_ORIG_BLOCKLIST.has(orig)) return 'Danh từ chung / chức danh / khái niệm phổ thông';
        if (GENERIC_ORIG_PREFIXES.some(p => orig.startsWith(p))) return 'Cụm mô tả chung, không phải tên riêng';

        // Kiểm tra nghĩa tiếng Việt: danh từ riêng luôn có chữ viết hoa
        if (!HAS_UPPERCASE_REGEX.test(hanviet)) return 'Nghĩa dịch viết thường toàn bộ (danh từ chung)';
        if (STARTS_LOWERCASE_REGEX.test(hanviet)) return 'Nghĩa dịch bắt đầu bằng chữ thường';

        const wordCount = hanviet.split(/\s+/).filter(Boolean).length;
        if (hanviet.length > 60 || wordCount > 8) return 'Nghĩa dịch quá dài (giải thích/câu)';

        return null;
    }

    // Phân tích và lọc 1 dòng trong phần [GLOSSARY] từ output của AI
    function parseGlossaryLine(rawLine) {
        if (!rawLine || typeof rawLine !== 'string') return null;

        let line = rawLine.trim();
        if (!line) return null;

        // Gỡ bullet / số thứ tự đầu dòng nếu AI lỡ thêm
        line = line.replace(/^(?:[-*•]+|\d+[.)、])\s*/, '').trim();
        if (!line || PLACEHOLDER_LINES.has(line.toLowerCase())) return null;

        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) return null;

        let left = stripGlossaryWrappers(line.slice(0, eqIdx));
        let right = stripTrailingNote(line.slice(eqIdx + 1));

        if (!left || !right || left === right) return null;

        // Phát hiện trường hợp AI đảo ngược: Nghĩa Việt = Từ Trung
        const leftHasHanzi = hasHanzi(left);
        const rightHasHanzi = hasHanzi(right);

        let orig = left;
        let hanviet = right;

        if (!leftHasHanzi && rightHasHanzi) {
            orig = right;
            hanviet = stripTrailingNote(left);
        } else if (!leftHasHanzi && !rightHasHanzi) {
            return null;
        } else if (leftHasHanzi && rightHasHanzi) {
            return null;
        }

        if (!orig || !hanviet || orig === hanviet) return null;
        if (getNonProperNounReason(orig, hanviet) !== null) return null;

        return { orig, hanviet };
    }

    // Quét toàn bộ từ điển hiện có để phát hiện các mục lỗi hoặc không phải tên riêng
    function analyzeGlossaryEntries(glossary) {
        const issues = [];
        const entries = Object.entries(glossary || {});

        for (const [orig, info] of entries) {
            const hanviet = (info && typeof info.hanviet === 'string') ? info.hanviet : '';
            const locked = Boolean(info && info.locked);

            const origHasHanzi = hasHanzi(orig);
            const hanvietHasHanzi = hasHanzi(hanviet);

            // 1. Lỗi đảo ngược Trung <-> Việt
            if (!origHasHanzi && hanvietHasHanzi) {
                const fixedOrig = stripGlossaryWrappers(hanviet);
                const fixedViet = stripTrailingNote(orig);
                const reasonAfterSwap = getNonProperNounReason(fixedOrig, fixedViet);

                if (reasonAfterSwap) {
                    issues.push({
                        orig,
                        hanviet,
                        locked,
                        category: 'swapped_junk',
                        action: 'delete',
                        reason: `Đảo ngược + ${reasonAfterSwap}`,
                        suggestedOrig: null,
                        suggestedHanviet: null
                    });
                } else if (glossary[fixedOrig] && fixedOrig !== orig) {
                    issues.push({
                        orig,
                        hanviet,
                        locked,
                        category: 'duplicate',
                        action: 'delete',
                        reason: `Đảo ngược & trùng với "${fixedOrig}" đã có`,
                        suggestedOrig: null,
                        suggestedHanviet: null
                    });
                } else {
                    issues.push({
                        orig,
                        hanviet,
                        locked,
                        category: 'swapped',
                        action: 'replace',
                        reason: 'Bị đảo ngược cột Trung ↔ Việt',
                        suggestedOrig: fixedOrig,
                        suggestedHanviet: fixedViet
                    });
                }
                continue;
            }

            // 2. Lỗi dính dấu ngoặc sách 《》, ngoặc kép, khoảng trắng thừa...
            const cleanOrig = stripGlossaryWrappers(orig);
            const cleanViet = stripTrailingNote(hanviet);
            const hasDirtyFormat = (cleanOrig !== orig || cleanViet !== hanviet);

            const nonProperReason = getNonProperNounReason(cleanOrig, cleanViet);
            if (nonProperReason) {
                issues.push({
                    orig,
                    hanviet,
                    locked,
                    category: 'non_proper',
                    action: 'delete',
                    reason: nonProperReason,
                    suggestedOrig: null,
                    suggestedHanviet: null
                });
                continue;
            }

            if (hasDirtyFormat) {
                if (cleanOrig !== orig && glossary[cleanOrig]) {
                    issues.push({
                        orig,
                        hanviet,
                        locked,
                        category: 'duplicate',
                        action: 'delete',
                        reason: `Dính dấu ngoặc & trùng với "${cleanOrig}" đã có`,
                        suggestedOrig: null,
                        suggestedHanviet: null
                    });
                } else {
                    issues.push({
                        orig,
                        hanviet,
                        locked,
                        category: 'dirty_format',
                        action: 'replace',
                        reason: 'Dính dấu ngoặc / ký tự thừa',
                        suggestedOrig: cleanOrig,
                        suggestedHanviet: cleanViet
                    });
                }
            }
        }

        // Sắp xếp: ưu tiên hiện lỗi nghiêm trọng (đảo ngược, dính ngoặc) trước, rồi tới rác
        const priority = { swapped: 1, dirty_format: 2, duplicate: 3, swapped_junk: 4, non_proper: 5 };
        issues.sort((a, b) => (priority[a.category] || 99) - (priority[b.category] || 99) || a.orig.localeCompare(b.orig));
        return issues;
    }

    const DEFAULT_BASE_PROMPT = 'Bạn là dịch giả truyện chữ tiếng Trung. Trả về văn bản dịch thuần túy sang tiếng Việt, giữ nguyên tuyệt đối cấu trúc ngắt dòng (newlines) của bản gốc. Dòng nào trống thì trả về dòng trống. Không dùng thẻ HTML hay Markdown.';

    function buildMatchedGlossaryContext(rawText, glossary = {}) {
        const filteredTerms = [];
        const matchedGlossary = {};
        const text = typeof rawText === 'string' ? rawText : '';
        for (const [orig, info] of Object.entries(glossary || {})) {
            if (!orig || !info) continue;
            const hanviet = typeof info === 'string' ? info : (info.hanviet || '');
            if (!hanviet || !text.includes(orig)) continue;
            filteredTerms.push({ orig, hanviet });
            matchedGlossary[orig] = hanviet;
        }
        filteredTerms.sort((a, b) => b.orig.length - a.orig.length);

        const glossarySection = filteredTerms.length > 0
            ? `Danh sách thuật ngữ đã dịch trước đó (bắt buộc dịch đúng theo danh sách này để nhất quán):\n` +
              filteredTerms.map(t => `${t.orig} = ${t.hanviet}`).join('\n')
            : '';

        return { filteredTerms, matchedGlossary, glossarySection };
    }

    function buildGlossaryRulesText(scopePhrase = 'chương này') {
        return `LƯU Ý QUAN TRỌNG VỀ PHẦN [GLOSSARY]:
- CHỈ liệt kê các DANH TỪ RIÊNG thực sự MỚI xuất hiện trong ${scopePhrase} (tên nhân vật, tên tông môn/thế lực, tên địa danh cụ thể, tên công pháp/chiêu thức/pháp bảo có tên riêng độc nhất) mà CHƯA có trong danh sách được cung cấp ở trên.
- TUYỆT ĐỐI KHÔNG THÊM:
  + Danh từ chung, nghề nghiệp, chức danh, xưng hô (VD: 店主/điếm chủ, 小二/tiểu nhị, 掌柜/chưởng quỹ, 长老/trưởng lão, 宗主/tông chủ, 师兄/sư huynh, 道友/đạo hữu, 前辈/tiền bối, 公子/công tử, 老者/lão giả...).
  + Vật phẩm, tài nguyên, cảnh giới tu luyện phổ thông hoặc cụm mô tả chung (VD: 灵石/linh thạch, 丹药/đan dược, 符箓/phù lục, 筑基/trúc cơ, 客栈/khách điếm, 平价制符铺/tiệm bán phù bình dân...).
- Định dạng bắt buộc mỗi dòng: <Tiếng Trung> = <Tiếng Việt Viết Hoa Chữ Cái Đầu>. Vế trái LUÔN LÀ tiếng Trung, vế phải LUÔN LÀ tiếng Việt.
- KHÔNG bọc từ bằng dấu 《》, "", 【】, () và KHÔNG thêm số thứ tự, gạch đầu dòng, hay chú thích giải thích.
- KHÔNG lặp lại các từ đã có trong danh sách được cung cấp.
- Nếu không có danh từ riêng mới nào xuất hiện, hãy để trống hoàn toàn phần dưới nhãn [GLOSSARY] (không viết thêm gì cả).`;
    }

    // Dựng system prompt + user message chuẩn cho cả dịch trực tiếp lẫn dịch trước chương sau
    function buildTranslationPromptPayload(pureTextForAPI, basePrompt, glossary = {}) {
        const promptText = basePrompt || DEFAULT_BASE_PROMPT;
        const { glossarySection } = buildMatchedGlossaryContext(pureTextForAPI, glossary);

        const formatInstructions = `YÊU CẦU ĐỊNH DẠNG ĐẦU RA:
Bạn phải trả về kết quả theo cấu trúc chính xác dưới đây:
[TRANSLATION]
<toàn bộ bản dịch tiếng Việt của chương truyện, giữ nguyên cấu trúc xuống dòng>
[GLOSSARY]
<Từ gốc tiếng Trung 1> = <Nghĩa dịch tiếng Việt 1>
<Từ gốc tiếng Trung 2> = <Nghĩa dịch tiếng Việt 2>

${buildGlossaryRulesText('chương này')}`;

        const promptBlocks = [promptText, formatInstructions];
        if (glossarySection) {
            promptBlocks.push(glossarySection);
        }

        return {
            finalSystemPrompt: promptBlocks.join("\n\n---\n\n"),
            userMessage: `Dịch toàn bộ nội dung sau sang tiếng Việt.\n\nNội dung cần dịch:\n${pureTextForAPI}\n\n---\n\n${formatInstructions}`
        };
    }

    /**
     * Build a glossary-only pre-extraction prompt over multiple upcoming chapters
     * so parallel chapter translations can share unified proper nouns.
     */
    function buildGlossaryPreExtractPromptPayload(combinedRawText, glossary = {}) {
        const rawText = typeof combinedRawText === 'string' ? combinedRawText : '';
        const { matchedGlossary, glossarySection } = buildMatchedGlossaryContext(rawText, glossary);
        const rules = buildGlossaryRulesText('các chương dưới đây');
        const formatInstructions = `YÊU CẦU ĐỊNH DẠNG ĐẦU RA:
KHÔNG dịch nội dung truyện. CHỈ xuất danh sách thuật ngữ theo cấu trúc chính xác dưới đây:
[GLOSSARY]
<Từ gốc tiếng Trung 1> = <Nghĩa dịch tiếng Việt 1>
<Từ gốc tiếng Trung 2> = <Nghĩa dịch tiếng Việt 2>

${rules}`;

        const systemBase = 'Bạn là chuyên gia trích xuất danh từ riêng (nhân vật, địa danh, tông môn, công pháp/chiêu thức/pháp bảo riêng) từ nguyên tác truyện chữ tiếng Trung để thống nhất từ điển trước khi dịch song song nhiều chương.';
        const promptBlocks = [systemBase, formatInstructions];
        if (glossarySection) {
            promptBlocks.push(glossarySection);
        }

        return {
            finalSystemPrompt: promptBlocks.join('\n\n---\n\n'),
            userMessage: `Trích xuất các danh từ riêng MỚI cần thống nhất từ các chương dưới đây (không dịch truyện):\n\n${rawText}\n\n---\n\n${formatInstructions}`,
            matchedGlossary
        };
    }

    function findMatchingGlossaryTerms(text, glossary = {}) {
        if (!text || typeof text !== 'string' || !glossary || typeof glossary !== 'object') {
            return {};
        }
        const matched = {};
        for (const [orig, info] of Object.entries(glossary)) {
            if (!orig || !info) continue;
            const hanviet = typeof info === 'string' ? info : (info.hanviet || '');
            if (hanviet && text.includes(orig)) {
                matched[orig] = hanviet;
            }
        }
        return matched;
    }

    function parseGlossaryBlockLines(content) {
        const newTerms = {};
        const skippedTerms = [];
        const trimmed = (content || '').trim();
        if (!trimmed) return { newTerms, skippedTerms };

        for (const line of trimmed.split('\n')) {
            const parsed = parseGlossaryLine(line);
            if (parsed) {
                newTerms[parsed.orig] = { hanviet: parsed.hanviet, locked: false };
            } else if (line.trim() && line.includes('=')) {
                skippedTerms.push(line.trim());
            }
        }
        return { newTerms, skippedTerms };
    }

    // Phân tích khối [GLOSSARY] ở cuối bản dịch để lưu các thuật ngữ mới hợp lệ
    function extractGlossaryTermsFromFullText(fullText) {
        const finalCleanText = (fullText || '').replace(/^```\w*\n?/gi, '').replace(/\n?```$/gi, '');
        if (!finalCleanText.includes('[GLOSSARY]')) {
            return { newTerms: {}, skippedTerms: [] };
        }
        return parseGlossaryBlockLines(finalCleanText.split('[GLOSSARY]')[1]);
    }

    /**
     * Extract glossary terms from a standalone glossary pre-extraction LLM response,
     * supporting both `[GLOSSARY]` headers and bare `orig = hanviet` line lists.
     */
    function extractGlossaryTermsFromResponseText(responseText) {
        const cleaned = (responseText || '').replace(/^```\w*\n?/gi, '').replace(/\n?```$/gi, '').trim();
        if (!cleaned) return { newTerms: {}, skippedTerms: [] };
        if (cleaned.includes('[GLOSSARY]')) {
            return extractGlossaryTermsFromFullText(cleaned);
        }
        return parseGlossaryBlockLines(cleaned);
    }

    // Gộp thuật ngữ mới vào glossary hiện tại, bảo vệ tuyệt đối các mục đã khóa (locked)
    function mergeGlossaryTerms(existingGlossary = {}, newTerms = {}) {
        const merged = { ...(existingGlossary || {}) };
        let updated = false;

        for (const [orig, info] of Object.entries(newTerms || {})) {
            if (!merged[orig] || !merged[orig].locked) {
                merged[orig] = info;
                updated = true;
            }
        }

        return { merged, updated };
    }

    // Trích xuất và lưu glossary từ toàn văn bản dịch vào chrome.storage.local (dùng chung cho cả dịch thường & preload)
    async function saveGlossaryFromFullText(fullText, activeProfile = '') {
        const { newTerms, skippedTerms } = extractGlossaryTermsFromFullText(fullText);
        let profile = activeProfile;
        if (!profile && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            const profData = await chrome.storage.local.get(['stv_active_glossary_profile']);
            profile = profData.stv_active_glossary_profile || 'Default';
        }
        profile = profile || 'Default';

        if (Object.keys(newTerms).length === 0 || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
            return {
                activeProfile: profile,
                newTerms,
                skippedTerms,
                updated: false,
                existingGlossary: null
            };
        }

        const glossaryKey = `stv_glossary_profile_${profile}`;
        const result = await chrome.storage.local.get([glossaryKey]);
        const existingGlossary = result[glossaryKey] || {};
        const { merged, updated } = mergeGlossaryTerms(existingGlossary, newTerms);

        if (updated) {
            await chrome.storage.local.set({ [glossaryKey]: merged });
        }

        return {
            activeProfile: profile,
            newTerms,
            skippedTerms,
            updated,
            existingGlossary: merged
        };
    }

    global.STV_GlossaryUtils = {
        hasHanzi,
        isPureChineseTerm,
        stripGlossaryWrappers,
        stripTrailingNote,
        getNonProperNounReason,
        parseGlossaryLine,
        analyzeGlossaryEntries,
        buildTranslationPromptPayload,
        buildGlossaryPreExtractPromptPayload,
        findMatchingGlossaryTerms,
        extractGlossaryTermsFromFullText,
        extractGlossaryTermsFromResponseText,
        mergeGlossaryTerms,
        saveGlossaryFromFullText
    };
})(typeof window !== 'undefined' ? window : globalThis);

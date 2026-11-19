/**
 * tts-icon-describer.js - Hybrid 3-tier Emoji / Emoticon / Kaomoji detector & describer for TTS.
 * Universal module (Browser Content Script, MV3 Service Worker, Node.js CommonJS).
 * Keeps page DOM untouched; produces clean spoken Vietnamese/English text for TTS engines.
 */
(function (global, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        const api = factory();
        global.STV_IconDescriber = api;
        if (typeof globalThis !== 'undefined') {
            globalThis.STV_IconDescriber = api;
        }
    }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    const VI_DIACRITICS_REGEX = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
    const HAN_KANA_HANGUL_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/;
    const LETTER_REGEX = /\p{L}/u;
    const ALNUM_REGEX = /[\p{L}\p{N}]/u;
    const COMBINING_MARK_REGEX = /\p{M}/u;
    const EXTENDED_PICTOGRAPHIC_REGEX = /\p{Extended_Pictographic}/u;
    const REGIONAL_INDICATOR_REGEX = /\p{Regional_Indicator}/u;

    // Scripts commonly used purely as decorative facial parts in modern Unicode kaomoji
    const EXOTIC_KAOMOJI_SCRIPT_REGEX = /[\p{Script=Gujarati}\p{Script=Georgian}\p{Script=Lao}\p{Script=Khmer}\p{Script=Tibetan}\p{Script=Canadian_Aboriginal}\p{Script=Cherokee}\p{Script=Myanmar}\p{Script=Sinhala}\p{Script=Malayalam}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Oriya}\p{Script=Bengali}\p{Script=Thai}\p{Script=Tagalog}\p{Script=Hanunoo}\p{Script=Yi}\p{Script=Bopomofo}\p{Script=Tai_Le}\p{Script=Tai_Tham}\p{Script=Ethiopic}\p{Script=Limbu}\p{Script=Vai}\p{Script=Bamum}\p{Script=Lepcha}\p{Script=Ol_Chiki}\p{Script=Sundanese}\p{Script=Balinese}\p{Script=Buginese}\u0966-\u096F\u06F5\u0669\u06F6\u0665]/u;

    // Phonetic / modifier / box-drawing / geometric / dingbat ranges common in kaomoji
    const KAOMOJI_SYMBOL_RANGE_REGEX = /[\u0250-\u02FF\u1D00-\u1DBF\u2500-\u25FF\u2600-\u27BF\u2900-\u2BFF\u2E00-\u2E7F\uFE30-\uFE4F]/;
    const KAOMOJI_MATH_ARROW_REGEX = /[\u2190-\u24FF]/;
    const KAOMOJI_CJK_FACE_PUNCT_REGEX = /[﹏︶︵︿﹀｡･ﾟ〃ヽﾉヾツ]/;
    const CONTEXT_GREEK_CYRILLIC_CJK_FACE_REGEX = /[ωεσεΘΦΨ∇дДзЗжшщ〇益皿艸凸囧ヮっつ]/;

    const KAOMOJI_OPEN_BRACKETS = new Set(['(', '（', '[', '【', '{', '꒰', '₍', '༼', 'ʕ']);
    const KAOMOJI_CLOSE_BRACKETS = new Set([')', '）', ']', '】', '}', '꒱', '₎', '༽', 'ʔ']);
    const KAOMOJI_BRACKET_MAP = {
        '(': ')', '（': '）', '[': ']', '【': '】', '{': '}',
        '꒰': '꒱', '₍': '₎', '༼': '༽', 'ʕ': 'ʔ'
    };
    const FACE_CONNECTOR_CHARS = new Set([
        '_', '-', '^', '~', '*', '`', '´', '/', '\\', '|', ';', '°', '•', '·', '｡', '･', 'ﾟ', '=', '+'
    ]);
    const SINGLE_FACE_ASCII_CHARS = new Set(['3', 'o', 'O', 'w', 'W', 'v', 'V', 'u', 'U', 'T', 'Q', 'A', 'x', 'X', 'z', 'Z', 'n', 'm', 'q', 'p', 'b', 'd']);
    const OUTER_PUNCT_SET = new Set(['.', ',', ':', ';', '!', '?', '"', "'", '“', '”', '‘', '’', '…']);
    const MATH_UNIT_GUARD_CHARS = new Set(['×', '÷', '±', '°', '≤', '≥', '≠', '≈', '∞', '→', '←', '²', '³', '¹', '℃', '℉', '%', '‰']);
    const STANDALONE_GREEK_MATH_CHARS = new Set(['α', 'β', 'γ', 'δ', 'ε', 'θ', 'λ', 'μ', 'π', 'ρ', 'σ', 'τ', 'φ', 'ω', 'Δ', 'Θ', 'Λ', 'Π', 'Σ', 'Φ', 'Ψ', 'Ω']);
    const STANDALONE_SYMBOL_EMOJIS = new Set(['♡', '♥', '♪', '♫', '♬', '💢', '💦', '💤', '✨', '🔥', '💔', '❤️', '❤', '❣', '💕', '💖', '💗', '💓', '💞', '💘', '💀', '☠️', '☠', '⭐', '🌟', '⚡', '❄', '❄️', '💧', '💎', '🚀', '⚔️', '⚔']);

    // Emoji regex supporting ZWJ, variation selectors, skin tones, keycaps, tags & regional flags
    const EMOJI_SEQUENCE_REGEX = /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F]|\u20E3|[\u{E0020}-\u{E007F}])*(?:\u200D\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F]|\u20E3|[\u{E0020}-\u{E007F}])*)*)/gu;

    const EMOJI_DICT = {
        '😭': { vi: 'khóc nức nở', en: 'sobbing loudly' },
        '😢': { vi: 'rơi nước mắt buồn bã', en: 'crying sadly' },
        '😥': { vi: 'buồn bã lo lắng', en: 'sad and anxious' },
        '😓': { vi: 'đổ mồ hôi mệt mỏi', en: 'sweating tiredly' },
        '😰': { vi: 'hoảng hốt đổ mồ hôi lạnh', en: 'breaking out in cold sweat' },
        '😨': { vi: 'sợ hãi kinh hãi', en: 'terrified' },
        '😱': { vi: 'hoảng hốt kinh ngạc', en: 'shocked in horror' },
        '🥺': { vi: 'mắt rưng rưng năn nỉ', en: 'pleading with teary eyes' },
        '🥹': { vi: 'rưng rưng xúc động', en: 'holding back tears' },
        '😞': { vi: 'thất vọng buồn bã', en: 'disappointed' },
        '😔': { vi: 'buồn rầu suy tư', en: 'pensive and sad' },
        '😟': { vi: 'lo âu', en: 'worried' },
        '😕': { vi: 'bối rối khó hiểu', en: 'confused' },
        '🙁': { vi: 'hơi buồn', en: 'slightly sad' },
        '☹️': { vi: 'buồn rầu nhăn mặt', en: 'frowning sadly' },
        '☹': { vi: 'buồn rầu nhăn mặt', en: 'frowning sadly' },
        '😣': { vi: 'nhăn mặt chịu đựng', en: 'enduring pain' },
        '😖': { vi: 'nhăn nhó khó chịu', en: 'confounded' },
        '😫': { vi: 'than trời mệt nhoài', en: 'exhausted' },
        '😩': { vi: 'rên rỉ chán nản', en: 'weary' },
        '😤': { vi: 'hậm hực phì mũi', en: 'huffing indignantly' },
        '😠': { vi: 'tức giận cau mày', en: 'angry frown' },
        '😡': { vi: 'nổi giận đùng đùng', en: 'furious' },
        '🤬': { vi: 'chửi thề giận dữ', en: 'swearing angrily' },
        '🤯': { vi: 'nổ tung đầu óc kinh ngạc', en: 'mind blown' },
        '😳': { vi: 'đỏ mặt ngượng ngùng', en: 'blushing awkwardly' },
        '🥵': { vi: 'nóng bừng mặt', en: 'overheated and flushed' },
        '🥶': { vi: 'lạnh run người', en: 'freezing cold' },
        '😶': { vi: 'câm lặng không nói nên lời', en: 'speechless' },
        '😐': { vi: 'mặt lạnh vô cảm', en: 'deadpan face' },
        '😑': { vi: 'bất lực cạn lời', en: 'expressionless' },
        '😒': { vi: 'liếc mắt chán chường', en: 'unamused' },
        '🙄': { vi: 'đảo mắt ngán ngẩm', en: 'rolling eyes' },
        '😬': { vi: 'cười gượng nghiến răng', en: 'grimacing awkwardly' },
        '🤥': { vi: 'nói dối chột dạ', en: 'lying awkwardly' },
        '😌': { vi: 'nhẹ nhõm thư thái', en: 'relieved' },
        '😴': { vi: 'ngủ say khò khò', en: 'sleeping soundly' },
        '😪': { vi: 'buồn ngủ ngáp dài', en: 'sleepy' },
        '🤤': { vi: 'chảy nước dãi thèm thuồng', en: 'drooling eagerly' },
        '😵': { vi: 'choáng váng hoa mắt', en: 'dizzy' },
        '😵‍💫': { vi: 'quay cuồng chóng mặt', en: 'dizzy and disoriented' },
        '🤢': { vi: 'buồn nôn khó chịu', en: 'nauseated' },
        '🤮': { vi: 'nôn mửa ghê tởm', en: 'vomiting in disgust' },
        '🤧': { vi: 'hắt hơi sụt sịt', en: 'sneezing' },
        '😷': { vi: 'đeo khẩu trang giữ kín', en: 'wearing a mask' },
        '🤒': { vi: 'ốm mệt', en: 'sick with fever' },
        '🤕': { vi: 'bị thương băng bó', en: 'injured' },
        '😂': { vi: 'cười ra nước mắt', en: 'laughing to tears' },
        '🤣': { vi: 'cười lăn lộn', en: 'rolling on the floor laughing' },
        '😅': { vi: 'cười gượng đổ mồ hôi', en: 'awkward sweat smile' },
        '😆': { vi: 'cười tít mắt khoái chí', en: 'laughing heartily' },
        '😁': { vi: 'cười toe toét', en: 'beaming grin' },
        '😄': { vi: 'cười tươi vui vẻ', en: 'happy smile' },
        '😃': { vi: 'mừng rỡ tươi cười', en: 'cheerful smile' },
        '😀': { vi: 'cười rạng rỡ', en: 'grinning face' },
        '😊': { vi: 'mỉm cười dịu dàng', en: 'warm smile' },
        '🙂': { vi: 'mỉm cười nhẹ', en: 'slight smile' },
        '🙃': { vi: 'cười trừ bất lực', en: 'upside-down wry smile' },
        '😉': { vi: 'nháy mắt tinh nghịch', en: 'playful wink' },
        '😍': { vi: 'mắt trái tim mê mẩn', en: 'heart eyes' },
        '🥰': { vi: 'mỉm cười hạnh phúc ngập tràn', en: 'smiling with hearts' },
        '😘': { vi: 'hôn gió ngọt ngào', en: 'blowing a kiss' },
        '😗': { vi: 'chu môi hôn', en: 'kissing face' },
        '😙': { vi: 'chu môi vui vẻ', en: 'smiling kiss' },
        '😚': { vi: 'ngượng ngùng chu môi', en: 'blushing kiss' },
        '😋': { vi: 'thèm ăn liếm mép', en: 'savoring delicious food' },
        '😛': { vi: 'lè lưỡi trêu ghẹo', en: 'sticking tongue out' },
        '😜': { vi: 'nháy mắt lè lưỡi tinh quái', en: 'winking tongue out' },
        '🤪': { vi: 'tinh nghịch lém lỉnh', en: 'zany playful face' },
        '😝': { vi: 'nhắm mắt lè lưỡi', en: 'squinting tongue out' },
        '🤑': { vi: 'mắt sáng rực thấy tiền', en: 'money-hungry' },
        '🤗': { vi: 'dang tay ôm ấp', en: 'warm hug' },
        '🤭': { vi: 'che miệng cười trộm', en: 'giggling behind hand' },
        '🫢': { vi: 'che miệng kinh ngạc', en: 'gasping with hand over mouth' },
        '🫣': { vi: 'lén nhìn qua kẽ tay', en: 'peeking nervously' },
        '🤫': { vi: 'ra dấu suỵt im lặng', en: 'shushing quietly' },
        '🤔': { vi: 'chống cằm suy ngẫm', en: 'deep in thought' },
        '🫡': { vi: 'giơ tay chào nghiêm trang', en: 'saluting respectfully' },
        '🤐': { vi: 'khóa miệng giữ bí mật', en: 'zipped lips' },
        '🤨': { vi: 'nhướn mày nghi hoặc', en: 'raising eyebrow suspiciously' },
        '😏': { vi: 'cười nhếch mép đắc ý', en: 'smirking' },
        '😒': { vi: 'lườm nguýt khó chịu', en: 'side-eyeing unamused' },
        '🥳': { vi: 'vui mừng ăn mừng', en: 'celebrating happily' },
        '😎': { vi: 'đeo kính ngầu lòi', en: 'cool sunglasses face' },
        '🤓': { vi: 'đeo kính mọt sách', en: 'nerdy glasses face' },
        '🧐': { vi: 'soi xét kỹ lưỡng', en: 'scrutinizing with monocle' },
        '🤩': { vi: 'mắt lấp lánh ngôi sao', en: 'star-struck amazed' },
        '😇': { vi: 'cười hiền như thiên thần', en: 'angelic innocent smile' },
        '😈': { vi: 'cười gian ác quỷ nhỏ', en: 'mischievous devil grin' },
        '👿': { vi: 'ác quỷ giận dữ', en: 'angry imp' },
        '🤡': { vi: 'cười tự giễu như chú hề', en: 'clown face' },
        '👻': { vi: 'hồn ma tinh nghịch', en: 'playful ghost' },
        '💀': { vi: 'sợ mất hồn khô héo', en: 'dead shocked' },
        '☠️': { vi: 'nguy hiểm chết chóc', en: 'skull danger' },
        '☠': { vi: 'nguy hiểm chết chóc', en: 'skull danger' },
        '💩': { vi: 'bó tay cạn lời', en: 'awkward mess' },
        '🐶': { vi: 'cún con dễ thương', en: 'cute puppy' },
        '🐱': { vi: 'mèo con đáng yêu', en: 'cute kitty' },
        '🦊': { vi: 'cáo nhỏ ranh mãnh', en: 'sly fox' },
        '🐺': { vi: 'sói hoang lạnh lùng', en: 'lone wolf' },
        '🐻': { vi: 'gấu con', en: 'bear' },
        '🐰': { vi: 'thỏ con', en: 'bunny' },
        '🐸': { vi: 'ếch xanh ngơ ngác', en: 'frog face' },
        '🙈': { vi: 'che mắt ngại ngùng', en: 'covering eyes shyly' },
        '🙉': { vi: 'bịt tai không nghe', en: 'covering ears' },
        '🙊': { vi: 'che miệng lỡ lời', en: 'oops covering mouth' },
        '❤️': { vi: 'trái tim yêu thương', en: 'red heart' },
        '❤': { vi: 'trái tim yêu thương', en: 'red heart' },
        '♥': { vi: 'trái tim yêu thương', en: 'heart' },
        '♡': { vi: 'trái tim nhỏ', en: 'open heart' },
        '🩷': { vi: 'trái tim hồng dịu dàng', en: 'pink heart' },
        '🧡': { vi: 'trái tim cam ấm áp', en: 'orange heart' },
        '💛': { vi: 'trái tim vàng', en: 'yellow heart' },
        '💚': { vi: 'trái tim xanh', en: 'green heart' },
        '💙': { vi: 'trái tim xanh dương', en: 'blue heart' },
        '💜': { vi: 'trái tim tím', en: 'purple heart' },
        '🖤': { vi: 'trái tim đen lạnh lùng', en: 'black heart' },
        '🤍': { vi: 'trái tim trắng', en: 'white heart' },
        '💔': { vi: 'tan nát cõi lòng', en: 'broken heart' },
        '❤️‍🔥': { vi: 'trái tim rực cháy', en: 'heart on fire' },
        '💕': { vi: 'hai trái tim ngọt ngào', en: 'two hearts' },
        '💖': { vi: 'trái tim lấp lánh', en: 'sparkling heart' },
        '💗': { vi: 'tim đập rộn ràng', en: 'growing heart' },
        '💓': { vi: 'tim đập thình thịch', en: 'beating heart' },
        '💘': { vi: 'tim trúng mũi tên tình yêu', en: 'cupid heart' },
        '❣️': { vi: 'chấm than trái tim', en: 'heart exclamation' },
        '❣': { vi: 'chấm than trái tim', en: 'heart exclamation' },
        '💋': { vi: 'dấu môi hôn', en: 'kiss mark' },
        '💢': { vi: 'nổi gân tức giận', en: 'anger vein' },
        '💥': { vi: 'bùng nổ dữ dội', en: 'explosion' },
        '💦': { vi: 'đổ mồ hôi lo lắng', en: 'sweating nervously' },
        '💨': { vi: 'vụt chạy thật nhanh', en: 'dashing away' },
        '💫': { vi: 'choáng váng quay cuồng', en: 'dizzy stars' },
        '💬': { vi: 'lời thoại', en: 'speech bubble' },
        '💭': { vi: 'suy nghĩ thầm', en: 'thought bubble' },
        '💤': { vi: 'ngủ khò', en: 'sleeping' },
        '🎵': { vi: 'ngân nga vui vẻ', en: 'musical note' },
        '🎶': { vi: 'ngân nga giai điệu vui', en: 'musical notes' },
        '♪': { vi: 'ngân nga vui vẻ', en: 'humming happily' },
        '♫': { vi: 'ngân nga giai điệu', en: 'singing happily' },
        '♬': { vi: 'ngân nga giai điệu', en: 'singing happily' },
        '👍': { vi: 'giơ ngón cái tán thưởng', en: 'thumbs up' },
        '👎': { vi: 'chê bai giơ ngón cái xuống', en: 'thumbs down' },
        '👏': { vi: 'vỗ tay hoan hô', en: 'clapping hands' },
        '🙌': { vi: 'giơ hai tay reo hò', en: 'raising hands in celebration' },
        '🙏': { vi: 'chắp tay khẩn cầu cảm ơn', en: 'folded hands praying' },
        '🤝': { vi: 'bắt tay thỏa thuận', en: 'handshake' },
        '👌': { vi: 'ra dấu ổn thỏa', en: 'okay hand' },
        '✌️': { vi: 'giơ tay chữ V vui vẻ', en: 'peace sign' },
        '✌': { vi: 'giơ tay chữ V vui vẻ', en: 'peace sign' },
        '🤞': { vi: 'bắt chéo tay cầu may', en: 'crossed fingers' },
        '🫶': { vi: 'tạo hình trái tim bằng tay', en: 'heart hands' },
        '💪': { vi: 'gồng cơ bắp quyết tâm', en: 'flexing determinedly' },
        '👊': { vi: 'tung nắm đấm', en: 'fist bump' },
        '✊': { vi: 'nắm chặt tay quyết tâm', en: 'raised fist' },
        '👋': { vi: 'vẫy tay chào', en: 'waving hand' },
        '🤦': { vi: 'ôm mặt bất lực', en: 'facepalming' },
        '🤷': { vi: 'nhún vai bó tay', en: 'shrugging' },
        '🙇': { vi: 'cúi đầu xin lỗi', en: 'bowing deeply' },
        '🔥': { vi: 'bùng cháy nhiệt huyết', en: 'fiery passion' },
        '✨': { vi: 'lấp lánh rạng rỡ', en: 'sparkling' },
        '🌟': { vi: 'tỏa sáng lấp lánh', en: 'glowing star' },
        '⭐': { vi: 'ngôi sao sáng', en: 'star' },
        '⚡': { vi: 'tia chớp mạnh mẽ', en: 'lightning bolt' },
        '❄️': { vi: 'băng giá lạnh lẽo', en: 'icy snowflake' },
        '❄': { vi: 'băng giá lạnh lẽo', en: 'icy snowflake' },
        '💧': { vi: 'giọt lệ lo lắng', en: 'droplet' },
        '💎': { vi: 'viên ngọc quý', en: 'precious gem' },
        '🚀': { vi: 'tên lửa vút bay', en: 'rocket launching' },
        '⚔️': { vi: 'song kiếm giao tranh', en: 'crossed swords' },
        '⚔': { vi: 'song kiếm giao tranh', en: 'crossed swords' },
        '🗡️': { vi: 'thanh kiếm sắc bén', en: 'sharp dagger' },
        '🛡️': { vi: 'khiên phòng thủ', en: 'shield' },
        '👑': { vi: 'vương miện tôn quý', en: 'royal crown' },
        '🎉': { vi: 'pháo hoa chúc mừng', en: 'celebration confetti' },
        '🎊': { vi: 'tung hoa ăn mừng', en: 'party popper' },
        '🏆': { vi: 'cúp chiến thắng', en: 'victory trophy' },
        '⚠️': { vi: 'cảnh báo nguy hiểm', en: 'warning' },
        '⚠': { vi: 'cảnh báo nguy hiểm', en: 'warning' },
        '❗': { vi: 'giật mình nhấn mạnh', en: 'exclamation' },
        '❓': { vi: 'ngơ ngác thắc mắc', en: 'questioning' },
        '‼️': { vi: 'kinh ngạc tột độ', en: 'double exclamation' },
        '⁉️': { vi: 'sửng sốt khó hiểu', en: 'shocked question' },
        '💯': { vi: 'tuyệt đối hoàn hảo', en: 'one hundred percent' },
        '☕': { vi: 'tách cà phê nóng', en: 'hot coffee' },
        '🍵': { vi: 'tách trà ấm', en: 'warm tea' },
        '🍺': { vi: 'cốc bia', en: 'beer mug' },
        '🍷': { vi: 'ly rượu vang', en: 'wine glass' },
        '🌹': { vi: 'bông hoa hồng', en: 'rose' },
        '🌸': { vi: 'cánh hoa anh đào', en: 'cherry blossom' },
        '☀️': { vi: 'nắng ấm chói chang', en: 'bright sun' },
        '🌙': { vi: 'trăng khuyết ban đêm', en: 'crescent moon' },
        '🌈': { vi: 'cầu vồng rực rỡ', en: 'rainbow' }
    };

    const KAOMOJI_DICT = {
        'qaq': { vi: 'mếu máo khóc lóc', en: 'crying piteously' },
        'qwq': { vi: 'rưng rưng muốn khóc', en: 'teary-eyed whimper' },
        'q_q': { vi: 'khóc ròng buồn bã', en: 'crying sadly' },
        't_t': { vi: 'khóc nức nở chảy nước mắt', en: 'streaming tears' },
        't^t': { vi: 'khóc mếu máo', en: 'sobbing' },
        't-t': { vi: 'khóc buồn bã', en: 'crying' },
        'tot': { vi: 'khóc òa lên', en: 'wailing in tears' },
        'tat': { vi: 'khóc mếu thương tâm', en: 'crying helplessly' },
        'orz': { vi: 'quỳ rạp xuống đất bất lực', en: 'kneeling in defeat' },
        'otl': { vi: 'gục ngã quỳ gối chán nản', en: 'collapsed on all fours' },
        'owo': { vi: 'tròn xoe mắt tò mò thích thú', en: 'wide-eyed curious delight' },
        'uwu': { vi: 'híp mắt dễ thương mãn nguyện', en: 'cute contented smile' },
        'o_o': { vi: 'trợn tròn mắt ngạc nhiên', en: 'staring wide-eyed' },
        '0_0': { vi: 'giật mình trợn tròn mắt', en: 'shocked wide eyes' },
        '@_@': { vi: 'choáng váng hoa mắt', en: 'dizzy and confused' },
        '$_$': { vi: 'mắt sáng rực tham tiền', en: 'money-struck eyes' },
        '*_*': { vi: 'mắt lấp lánh mê mẩn', en: 'starry-eyed amazed' },
        '>_<': { vi: 'nhắm tịt mắt nhăn nhó', en: 'grimacing tightly' },
        '>_>': { vi: 'liếc nhìn nghi ngờ', en: 'suspicious side-glance' },
        '<_<': { vi: 'liếc mắt dè chừng', en: 'wary side-glance' },
        '=_=': { vi: 'nheo mắt chán nản cạn lời', en: 'deadpan unimpressed' },
        '= =': { vi: 'mặt đơ cạn lời', en: 'speechless deadpan' },
        '-_-': { vi: 'thở dài ngao ngán', en: 'unamused sigh' },
        '-_-||': { vi: 'chảy mồ hôi hột ngao ngán', en: 'sweating unamused' },
        '^_^': { vi: 'mỉm cười vui vẻ', en: 'happy smile' },
        '^o^': { vi: 'cười hớn hở reo vui', en: 'cheerful laugh' },
        '^v^': { vi: 'mỉm cười rạng rỡ', en: 'bright smile' },
        'xd': { vi: 'cười tít mắt sảng khoái', en: 'laughing hard' },
        ":'(": { vi: 'rơi nước mắt buồn bã', en: 'crying sad face' },
        ":'-(": { vi: 'rơi nước mắt buồn bã', en: 'crying sad face' },
        ':((': { vi: 'buồn bã mếu máo', en: 'very sad frown' },
        ':(': { vi: 'buồn bã xị mặt', en: 'sad frown' },
        ':))': { vi: 'cười ha hả khoái chí', en: 'big laughing grin' },
        ':)': { vi: 'mỉm cười nhẹ', en: 'smile' },
        ':d': { vi: 'cười toe toét rạng rỡ', en: 'big happy grin' },
        ':p': { vi: 'lè lưỡi trêu ghẹo', en: 'playful tongue out' },
        ':v': { vi: 'nhếch miệng cười đểu', en: 'smug playful grin' },
        ':3': { vi: 'chu môi đáng yêu như mèo', en: 'cute cat-mouth smile' },
        '=))': { vi: 'cười lăn lộn khoái trá', en: 'laughing uproariously' },
        '=((': { vi: 'buồn rầu khóc thầm', en: 'crying sadly' },
        '<3': { vi: 'trái tim yêu thương', en: 'heart' },
        '</3': { vi: 'tan nát cõi lòng', en: 'broken heart' },
        '(-_-)': { vi: 'nhắm mắt ngao ngán', en: 'tired deadpan' },
        '(-_-;)': { vi: 'toát mồ hôi ngao ngán', en: 'nervous sweat sigh' },
        '(=_=)': { vi: 'lờ đờ chán nản', en: 'bored deadpan' },
        '(^_^)': { vi: 'cười tươi thân thiện', en: 'friendly smile' },
        '(>_<)': { vi: 'nhắm mắt nhăn nhó bối rối', en: 'flustered wince' },
        '(;_;)': { vi: 'khóc sụt sùi', en: 'crying softly' },
        'o(╥﹏╥)o': { vi: 'ôm mặt khóc nức nở', en: 'sobbing uncontrollably' },
        '(╥﹏╥)': { vi: 'khóc nức nở đau khổ', en: 'sobbing bitterly' },
        '(つд⊂)': { vi: 'che mặt khóc nức nở', en: 'hiding face crying' },
        '(╯°□°）╯︵ ┻━┻': { vi: 'nổi điên lật bàn tức giận', en: 'flipping table in rage' },
        '(╯°□°)╯︵ ┻━┻': { vi: 'nổi điên lật bàn tức giận', en: 'flipping table in rage' },
        '┻━┻': { vi: 'bàn bị hất tung tức giận', en: 'flipped table anger' },
        'ヽ(°〇°)ﾉ': { vi: 'giật mình sửng sốt há hốc mồm', en: 'gasping in shock' },
        '(￣▽￣)"': { vi: 'cười trừ gãi đầu ngượng ngùng', en: 'awkward sheepish smile' },
        '(￣▽￣)': { vi: 'mỉm cười tự mãn', en: 'smug satisfied smile' },
        '(⊙_⊙)?': { vi: 'trợn tròn mắt ngơ ngác khó hiểu', en: 'wide-eyed bewildered' },
        '(⊙_⊙)': { vi: 'trợn mắt sững sờ', en: 'stunned stare' },
        '╮(╯▽╰)╭': { vi: 'nhún vai bất lực chịu thua', en: 'helpless shrug' },
        '(*≧ω≦)': { vi: 'sung sướng phấn khích tột độ', en: 'overjoyed excitement' },
        '(⁄ ⁄•⁄ω⁄•⁄ ⁄)': { vi: 'ngượng chín mặt đỏ bừng', en: 'blushing intensely' },
        '(*/ω＼*)': { vi: 'che mặt xấu hổ đỏ bừng', en: 'shyly hiding blushing face' },
        '(♡˙︶˙♡)': { vi: 'ngất ngây hạnh phúc ngập tràn', en: 'blissfully in love' },
        '(ง •̀_•́)ง': { vi: 'nắm tay quyết tâm hừng hực khí thế', en: 'fired up and determined' },
        '(눈_눈)': { vi: 'lườm nguýt sắc lẹm', en: 'sharp suspicious glare' }
    };

    const ASCII_EMOTICONS_ORDERED = [
        '-_-||', 'QAQ', 'QwQ', 'Q_Q', 'QWQ', 'T_T', 'T^T', 'T-T', 'ToT', 'TAT',
        'Orz', 'OTL', 'OwO', 'UwU', 'O_O', 'o_o', '0_0', '@_@', '$_$', '*_*',
        '>_<', '>_>', '<_<', '=_=', '= =', '-_-', '^_^', '^o^', '^v^', 'XD', 'xD',
        ":'-(", ":'(", ':((', ':(', ':))', ':)', ':D', ':P', ':p', ':v', ':3',
        '=))', '=((', '</3', '<3'
    ];

    function detectLanguage(text, fallbackLocale = 'vi') {
        const s = String(text || '');
        if (VI_DIACRITICS_REGEX.test(s)) return 'vi';
        if (fallbackLocale === 'en') {
            const asciiWords = s.match(/\b[a-zA-Z]{2,}\b/g);
            if (asciiWords && asciiWords.length >= 2) return 'en';
        }
        return fallbackLocale === 'en' ? 'en' : 'vi';
    }

    function isCjkProseText(text) {
        const s = String(text || '');
        let letters = 0;
        let cjk = 0;
        for (const ch of s) {
            if (LETTER_REGEX.test(ch)) {
                letters += 1;
                if (HAN_KANA_HANGUL_REGEX.test(ch)) {
                    cjk += 1;
                }
            }
        }
        return letters >= 4 && (cjk / letters) > 0.3;
    }

    function hasCustomIconMatch(text, customIcons) {
        if (!text || !customIcons || typeof customIcons !== 'object') return false;
        const s = String(text);
        const trimmed = s.trim();
        for (const k of Object.keys(customIcons)) {
            if (!k) continue;
            if (trimmed === k || s.includes(k)) return true;
        }
        return false;
    }

    function isDecorativeSeparatorLine(text, customIcons = null) {
        const trimmed = String(text || '').trim();
        if (!trimmed) return true;
        if (customIcons && hasCustomIconMatch(trimmed, customIcons)) {
            return false;
        }
        if (/[\p{L}\p{N}]/u.test(trimmed)) {
            return false;
        }
        // Pure punctuation / symbols / stars / lines with >= 2 chars (excluding standalone emotional symbols)
        const compact = trimmed.replace(/\s+/g, '');
        if (!compact) return true;
        const cps = Array.from(compact);
        if (cps.length >= 2 && cps.every((ch) => STANDALONE_SYMBOL_EMOJIS.has(ch) || EXTENDED_PICTOGRAPHIC_REGEX.test(ch))) {
            // Only treat 3+ repeated stars/boxes/diamonds as scene breaks, keep repeated heart/cry/music emojis
            const first = cps[0];
            if (cps.length >= 3 && /^[★☆◆◇❖✦✧●○■□▲△▼▽━─═\-_*~•·=+]$/.test(first) && cps.every((c) => c === first)) {
                return true;
            }
            return false;
        }
        if (/^[\-_=\*~•·\|\\\/\+<>.,:;!?…★☆◆◇❖✦✧●○■□▲△▼▽━─═]+$/.test(compact)) {
            return true;
        }
        return false;
    }

    function toCodePointUnits(str) {
        const units = [];
        let i = 0;
        while (i < str.length) {
            const cp = str.codePointAt(i);
            const len = cp > 0xFFFF ? 2 : 1;
            const ch = str.slice(i, i + len);
            units.push({ ch, cp, start: i, end: i + len });
            i += len;
        }
        return units;
    }

    function isAsciiWordChar(ch) {
        return /[A-Za-z0-9]/.test(ch);
    }

    function isNormalWordLetter(ch) {
        if (!LETTER_REGEX.test(ch)) return false;
        if (EXOTIC_KAOMOJI_SCRIPT_REGEX.test(ch)) return false;
        if (CONTEXT_GREEK_CYRILLIC_CJK_FACE_REGEX.test(ch)) return false;
        if (/[\u0250-\u02FF\u1D00-\u1DBF]/.test(ch)) return false;
        // Normal Latin/Vietnamese/Arabic/Hebrew letters
        return /[A-Za-zÀ-ỹ\u0621-\u064A\u0590-\u05FF]/.test(ch) || HAN_KANA_HANGUL_REGEX.test(ch);
    }

    function isPartOfNormalWord(units, idx) {
        const u = units[idx];
        if (!u) return false;
        const prev = units[idx - 1];
        const next = units[idx + 1];
        const curIsWord = isNormalWordLetter(u.ch) || /[0-9]/.test(u.ch);
        if (!curIsWord) return false;
        const prevIsWord = prev && (isNormalWordLetter(prev.ch) || /[0-9]/.test(prev.ch));
        const nextIsWord = next && (isNormalWordLetter(next.ch) || /[0-9]/.test(next.ch));
        return Boolean(prevIsWord || nextIsWord);
    }

    function isMathOrUnitNeighbor(units, idx) {
        const u = units[idx];
        if (!u) return false;
        const prev = units[idx - 1];
        const next = units[idx + 1];
        const ch = u.ch;

        if (ch === '°') {
            if (prev && /[0-9]/.test(prev.ch)) return true;
            if (next && /^[CFKc]$/.test(next.ch)) return true;
        }
        if (ch === '¹' || ch === '²' || ch === '³') {
            if (prev && /[0-9a-zA-Z²³mckg]/.test(prev.ch)) return true;
        }
        if (MATH_UNIT_GUARD_CHARS.has(ch)) {
            const pDigit = prev && (/[0-9]/.test(prev.ch) || prev.ch === ' ');
            const nDigit = next && (/[0-9]/.test(next.ch) || next.ch === ' ');
            const pNum = units[idx - 1] && /[0-9]/.test(units[idx - 1].ch) || (units[idx - 1]?.ch === ' ' && units[idx - 2] && /[0-9]/.test(units[idx - 2].ch));
            const nNum = units[idx + 1] && /[0-9]/.test(units[idx + 1].ch) || (units[idx + 1]?.ch === ' ' && units[idx + 2] && /[0-9]/.test(units[idx + 2].ch));
            if (pNum || nNum || (pDigit && nDigit)) return true;
        }
        return false;
    }

    function isStrongAnchorUnit(units, idx, isCjkProse) {
        const u = units[idx];
        if (!u) return false;
        const ch = u.ch;

        if (EXTENDED_PICTOGRAPHIC_REGEX.test(ch) || REGIONAL_INDICATOR_REGEX.test(ch)) {
            return false; // handled in Emoji pass
        }
        if (isMathOrUnitNeighbor(units, idx)) {
            return false;
        }
        if (EXOTIC_KAOMOJI_SCRIPT_REGEX.test(ch)) {
            return true;
        }
        if (KAOMOJI_SYMBOL_RANGE_REGEX.test(ch)) {
            // Exclude common standalone prose stars/bullets unless next to another kaomoji char/bracket
            if (/^[★☆●○•·]$/.test(ch)) {
                const prev = units[idx - 1]?.ch || '';
                const next = units[idx + 1]?.ch || '';
                return KAOMOJI_OPEN_BRACKETS.has(prev) || KAOMOJI_CLOSE_BRACKETS.has(next)
                    || EXOTIC_KAOMOJI_SCRIPT_REGEX.test(prev) || EXOTIC_KAOMOJI_SCRIPT_REGEX.test(next)
                    || KAOMOJI_SYMBOL_RANGE_REGEX.test(prev) || KAOMOJI_SYMBOL_RANGE_REGEX.test(next);
            }
            // Exclude single-char standalone musical/heart symbols here so Pass 1/symbol pass treats them cleanly unless touching brackets/anchors
            return true;
        }
        if (KAOMOJI_MATH_ARROW_REGEX.test(ch)) {
            // Keep math operators like ∑ ∏ √ ∈ away unless near anchors/brackets; allow ⋋ ⋌ ≦ ≧ ▽ etc.
            if (/[≤≥≠≈∞±×÷∑∏√∫]/.test(ch)) {
                const prev = units[idx - 1]?.ch || '';
                const next = units[idx + 1]?.ch || '';
                return EXOTIC_KAOMOJI_SCRIPT_REGEX.test(prev) || EXOTIC_KAOMOJI_SCRIPT_REGEX.test(next)
                    || KAOMOJI_OPEN_BRACKETS.has(prev) || KAOMOJI_CLOSE_BRACKETS.has(next);
            }
            return true;
        }
        if (KAOMOJI_CJK_FACE_PUNCT_REGEX.test(ch)) {
            return true;
        }
        // Combining marks attached to non-native/symbol bases or stacked (>=2) combining marks on symbol/exotic chars
        if (COMBINING_MARK_REGEX.test(ch)) {
            let baseIdx = idx - 1;
            let markCount = 1;
            while (baseIdx >= 0 && COMBINING_MARK_REGEX.test(units[baseIdx].ch)) {
                markCount += 1;
                baseIdx -= 1;
            }
            const baseChar = baseIdx >= 0 ? units[baseIdx].ch : '';
            if (!baseChar) return true;
            // Native scripts with combining marks (Latin/VN, Hebrew, Arabic, Devanagari, Thai, Hangul) are prose
            if (/[\p{Script=Latin}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Thai}\p{Script=Hangul}]/u.test(baseChar)
                && !EXOTIC_KAOMOJI_SCRIPT_REGEX.test(baseChar)) {
                return false;
            }
            if (markCount >= 2 || EXOTIC_KAOMOJI_SCRIPT_REGEX.test(baseChar) || KAOMOJI_SYMBOL_RANGE_REGEX.test(baseChar) || CONTEXT_GREEK_CYRILLIC_CJK_FACE_REGEX.test(baseChar)) {
                return true;
            }
        }
        // Context-dependent face chars (Greek/Cyrillic/CJK face chars) only act as anchors when touching another anchor, bracket, or connector
        if (CONTEXT_GREEK_CYRILLIC_CJK_FACE_REGEX.test(ch)) {
            if (isCjkProse && HAN_KANA_HANGUL_REGEX.test(ch)) {
                return false;
            }
            if (STANDALONE_GREEK_MATH_CHARS.has(ch)) {
                const prev = units[idx - 1]?.ch || '';
                const next = units[idx + 1]?.ch || '';
                const nearKaomoji = EXOTIC_KAOMOJI_SCRIPT_REGEX.test(prev) || EXOTIC_KAOMOJI_SCRIPT_REGEX.test(next)
                    || KAOMOJI_SYMBOL_RANGE_REGEX.test(prev) || KAOMOJI_SYMBOL_RANGE_REGEX.test(next)
                    || KAOMOJI_CJK_FACE_PUNCT_REGEX.test(prev) || KAOMOJI_CJK_FACE_PUNCT_REGEX.test(next)
                    || COMBINING_MARK_REGEX.test(next)
                    || FACE_CONNECTOR_CHARS.has(prev) || FACE_CONNECTOR_CHARS.has(next);
                if (!nearKaomoji) return false;
            }
            const prev = units[idx - 1]?.ch || '';
            const next = units[idx + 1]?.ch || '';
            const prevWord = isNormalWordLetter(prev);
            const nextWord = isNormalWordLetter(next);
            if (prevWord || nextWord) return false;
            if (prev || next) {
                if (EXOTIC_KAOMOJI_SCRIPT_REGEX.test(prev) || EXOTIC_KAOMOJI_SCRIPT_REGEX.test(next)
                    || KAOMOJI_SYMBOL_RANGE_REGEX.test(prev) || KAOMOJI_SYMBOL_RANGE_REGEX.test(next)
                    || KAOMOJI_OPEN_BRACKETS.has(prev) || KAOMOJI_CLOSE_BRACKETS.has(next)
                    || FACE_CONNECTOR_CHARS.has(prev) || FACE_CONNECTOR_CHARS.has(next)
                    || CONTEXT_GREEK_CYRILLIC_CJK_FACE_REGEX.test(prev) || CONTEXT_GREEK_CYRILLIC_CJK_FACE_REGEX.test(next)
                    || KAOMOJI_CJK_FACE_PUNCT_REGEX.test(prev) || KAOMOJI_CJK_FACE_PUNCT_REGEX.test(next)
                    || COMBINING_MARK_REGEX.test(next)) {
                    return true;
                }
            }
        }
        return false;
    }

    function isFaceAttachableUnit(units, idx, isCjkProse, inEmojiMask) {
        if (idx < 0 || idx >= units.length) return false;
        if (inEmojiMask[idx]) return false;
        const ch = units[idx].ch;
        if (isStrongAnchorUnit(units, idx, isCjkProse)) return true;
        if (COMBINING_MARK_REGEX.test(ch)) {
            let b = idx - 1;
            while (b >= 0 && COMBINING_MARK_REGEX.test(units[b].ch)) b -= 1;
            const baseChar = b >= 0 ? units[b].ch : '';
            if (baseChar && isNormalWordLetter(baseChar) && !EXOTIC_KAOMOJI_SCRIPT_REGEX.test(baseChar)) {
                return false;
            }
            return true;
        }
        if (CONTEXT_GREEK_CYRILLIC_CJK_FACE_REGEX.test(ch)) {
            if (isCjkProse && HAN_KANA_HANGUL_REGEX.test(ch)) return false;
            return !isPartOfNormalWord(units, idx);
        }
        if (KAOMOJI_OPEN_BRACKETS.has(ch) || KAOMOJI_CLOSE_BRACKETS.has(ch)) return true;
        if (FACE_CONNECTOR_CHARS.has(ch) && !isMathOrUnitNeighbor(units, idx)) return true;
        if (SINGLE_FACE_ASCII_CHARS.has(ch) && !isPartOfNormalWord(units, idx)) return true;
        return false;
    }

    function hasAnchorInRange(units, fromIdx, toIdx, isCjkProse) {
        for (let i = fromIdx; i <= toIdx && i < units.length; i++) {
            if (isStrongAnchorUnit(units, i, isCjkProse)) return true;
        }
        return false;
    }

    function isBracketedFaceInterior(interiorUnits, isCjkProse) {
        if (interiorUnits.length < 2 || interiorUnits.length > 34) return false;
        let hasWord = false;
        let runLetters = 0;
        let faceSignalCount = 0;
        let hasExotic = false;

        for (let i = 0; i < interiorUnits.length; i++) {
            const ch = interiorUnits[i].ch;
            if (isStrongAnchorUnit(interiorUnits, i, isCjkProse)) {
                hasExotic = true;
                faceSignalCount += 2;
                runLetters = 0;
                continue;
            }
            if (ch === ' ' || ch === '\t') {
                runLetters = 0;
                continue;
            }
            if (isNormalWordLetter(ch) || /[0-9]/.test(ch)) {
                if (SINGLE_FACE_ASCII_CHARS.has(ch) && runLetters === 0) {
                    const nextCh = interiorUnits[i + 1]?.ch || '';
                    if (!nextCh || (!isNormalWordLetter(nextCh) && !/[0-9]/.test(nextCh))) {
                        faceSignalCount += 0.5;
                        runLetters = 1;
                        continue;
                    }
                }
                runLetters += 1;
                if (runLetters >= 2) {
                    hasWord = true;
                    break;
                }
            } else {
                runLetters = 0;
                if (FACE_CONNECTOR_CHARS.has(ch) || ch === ' ' || ch === '°' || ch === '•' || ch === '·') {
                    faceSignalCount += 1;
                }
            }
        }
        if (hasWord) return false;
        if (hasExotic) return true;
        // Pure ASCII/punct face inside brackets e.g. (-_-), (-_-;), (^_^), (>_<), (;_;)
        const raw = interiorUnits.map((u) => u.ch).join('');
        if (/^[\s\-_=]+$/.test(raw)) return false; // just (--) or (===)
        return faceSignalCount >= 2;
    }

    function overlapsExisting(tokens, start, end) {
        for (let i = 0; i < tokens.length; i++) {
            if (start < tokens[i].end && end > tokens[i].start) return true;
        }
        return false;
    }

    function detectIcons(rawText, options = {}) {
        const text = String(rawText || '');
        const customIcons = options.customIcons && typeof options.customIcons === 'object' ? options.customIcons : null;
        if (!text || isDecorativeSeparatorLine(text, customIcons)) return [];

        const isCjkProse = options.isCjkProse !== undefined ? Boolean(options.isCjkProse) : isCjkProseText(text);
        const tokens = [];

        // Pass 1: Unicode Emoji sequences (merged when identical & adjacent)
        EMOJI_SEQUENCE_REGEX.lastIndex = 0;
        const rawEmojis = [];
        let em;
        while ((em = EMOJI_SEQUENCE_REGEX.exec(text)) !== null) {
            rawEmojis.push({
                raw: em[0],
                start: em.index,
                end: em.index + em[0].length
            });
        }
        for (let i = 0; i < rawEmojis.length; i++) {
            const cur = rawEmojis[i];
            let end = cur.end;
            let count = 1;
            while (i + 1 < rawEmojis.length) {
                const nxt = rawEmojis[i + 1];
                const gap = text.slice(end, nxt.start);
                if (nxt.raw === cur.raw && /^\s*$/.test(gap)) {
                    end = nxt.end;
                    count += 1;
                    i += 1;
                } else {
                    break;
                }
            }
            tokens.push({
                type: 'emoji',
                raw: text.slice(cur.start, end),
                baseRaw: cur.raw,
                start: cur.start,
                end,
                repeatCount: count
            });
        }

        // Pass 1.5: Custom user-defined icons / kaomoji / symbols not already covered by Pass 1 emojis
        if (customIcons) {
            const customKeys = Object.keys(customIcons)
                .map((k) => normalizeCacheKey(k))
                .filter(Boolean)
                .sort((a, b) => b.length - a.length);

            for (const key of customKeys) {
                const isPureAlnum = /^[\p{L}\p{N}]+$/u.test(key);
                let from = 0;
                while (from < text.length) {
                    const pos = text.indexOf(key, from);
                    if (pos === -1) break;
                    const end = pos + key.length;
                    from = pos + 1;
                    if (overlapsExisting(tokens, pos, end)) continue;
                    if (isPureAlnum) {
                        const before = pos > 0 ? text[pos - 1] : '';
                        const after = end < text.length ? text[end] : '';
                        if ((before && ALNUM_REGEX.test(before)) || (after && ALNUM_REGEX.test(after))) {
                            continue;
                        }
                    }
                    tokens.push({
                        type: 'custom',
                        raw: key,
                        baseRaw: key,
                        start: pos,
                        end,
                        repeatCount: 1
                    });
                }
            }
        }

        const units = toCodePointUnits(text);
        const inEmojiMask = new Array(units.length).fill(false);
        for (let uIdx = 0; uIdx < units.length; uIdx++) {
            const u = units[uIdx];
            if (overlapsExisting(tokens, u.start, u.end)) {
                inEmojiMask[uIdx] = true;
            }
        }

        // Pass 2: Exotic Unicode & Bracketed Kaomoji detection
        const visitedUnit = new Array(units.length).fill(false);
        for (let idx = 0; idx < units.length; idx++) {
            if (inEmojiMask[idx] || visitedUnit[idx]) continue;

            // 2A. Check bracketed kaomoji e.g. o(╥﹏╥)o, (>_<), (-_-;)
            const ch = units[idx].ch;
            if (KAOMOJI_OPEN_BRACKETS.has(ch)) {
                const expectedClose = KAOMOJI_BRACKET_MAP[ch];
                let closeIdx = -1;
                let depth = 0;
                const searchLimit = Math.min(units.length - 1, idx + 36);
                for (let j = idx + 1; j <= searchLimit; j++) {
                    if (inEmojiMask[j]) break;
                    const c = units[j].ch;
                    if (c === ch) depth += 1;
                    else if (c === expectedClose) {
                        if (depth === 0) {
                            closeIdx = j;
                            break;
                        }
                        depth -= 1;
                    }
                }
                if (closeIdx > idx + 1) {
                    const interior = units.slice(idx + 1, closeIdx);
                    if (isBracketedFaceInterior(interior, isCjkProse)) {
                        let left = idx;
                        let right = closeIdx;
                        while (left > 0 && isFaceAttachableUnit(units, left - 1, isCjkProse, inEmojiMask)) {
                            left -= 1;
                        }
                        while (right + 1 < units.length && isFaceAttachableUnit(units, right + 1, isCjkProse, inEmojiMask)) {
                            right += 1;
                        }
                        // Also allow bridging to trailing spaced kaomoji parts (e.g. `(╯°□°）╯︵ ┻━┻`)
                        while (right + 1 < units.length) {
                            let sp = right + 1;
                            let spaceCount = 0;
                            while (sp < units.length && (units[sp].ch === ' ' || units[sp].ch === '\t')) {
                                spaceCount += 1;
                                sp += 1;
                            }
                            if (spaceCount >= 1 && spaceCount <= 2 && sp < units.length && !inEmojiMask[sp]) {
                                let probeEnd = sp;
                                while (probeEnd < units.length && isFaceAttachableUnit(units, probeEnd, isCjkProse, inEmojiMask)) {
                                    probeEnd += 1;
                                }
                                if (probeEnd > sp && hasAnchorInRange(units, sp, probeEnd - 1, isCjkProse)) {
                                    right = probeEnd - 1;
                                    continue;
                                }
                            }
                            break;
                        }
                        while (left < idx && OUTER_PUNCT_SET.has(units[left].ch)) left += 1;
                        while (right > closeIdx && OUTER_PUNCT_SET.has(units[right].ch)) right -= 1;
                        // Absorb classic trailing sweat-drop `"` on `(￣▽￣)"` only when total quotes are odd (unpaired quote)
                        if (right === closeIdx && right + 1 < units.length && units[right + 1].ch === '"') {
                            const totalQuotes = text.split('"').length - 1;
                            const quoteCountBefore = text.slice(0, units[left].start).split('"').length - 1;
                            if (totalQuotes % 2 === 1 && quoteCountBefore % 2 === 0) {
                                right += 1;
                            }
                        }

                        const tokStart = units[left].start;
                        const tokEnd = units[right].end;
                        if (!overlapsExisting(tokens, tokStart, tokEnd)) {
                            for (let k = left; k <= right; k++) visitedUnit[k] = true;
                            tokens.push({
                                type: 'kaomoji',
                                raw: text.slice(tokStart, tokEnd),
                                baseRaw: text.slice(tokStart, tokEnd),
                                start: tokStart,
                                end: tokEnd,
                                repeatCount: 1
                            });
                            idx = right;
                            continue;
                        }
                    }
                }
            }

            // 2B. Strong exotic anchor cluster expansion (e.g. `૮ε˚۵ ⋋ʌ⋋۵ 3˚ა`)
            if (!isStrongAnchorUnit(units, idx, isCjkProse)) continue;

            let left = idx;
            let right = idx;

            const expandRight = () => {
                while (right + 1 < units.length) {
                    const nxt = right + 1;
                    if (isFaceAttachableUnit(units, nxt, isCjkProse, inEmojiMask)) {
                        right = nxt;
                        continue;
                    }
                    // Allow short space bridge (1-2 spaces) if the next segment contains an anchor or attached single face unit + anchor
                    let sp = nxt;
                    let spaceCount = 0;
                    while (sp < units.length && (units[sp].ch === ' ' || units[sp].ch === '\t')) {
                        spaceCount += 1;
                        sp += 1;
                    }
                    if (spaceCount >= 1 && spaceCount <= 2 && sp < units.length && !inEmojiMask[sp]) {
                        let probe = sp;
                        let sawWordBoundaryFail = false;
                        while (probe < units.length && isFaceAttachableUnit(units, probe, isCjkProse, inEmojiMask)) {
                            probe += 1;
                        }
                        if (probe > sp) {
                            // Verify it's not normal prose words and actually contains a strong anchor (or bracketed face)
                            if (hasAnchorInRange(units, sp, probe - 1, isCjkProse)) {
                                right = probe - 1;
                                continue;
                            }
                        }
                        if (!sawWordBoundaryFail) break;
                    }
                    break;
                }
            };

            const expandLeft = () => {
                while (left > 0) {
                    const prv = left - 1;
                    if (isFaceAttachableUnit(units, prv, isCjkProse, inEmojiMask)) {
                        left = prv;
                        continue;
                    }
                    break;
                }
            };

            expandLeft();
            expandRight();

            // Trim trailing/leading standalone spaces or outer sentence punctuation (not part of brackets/faces)
            while (left <= right && (OUTER_PUNCT_SET.has(units[left].ch) || units[left].ch === ' ')) {
                left += 1;
            }
            while (right >= left && (OUTER_PUNCT_SET.has(units[right].ch) || units[right].ch === ' ')) {
                right -= 1;
            }

            if (left > right) continue;
            const tokStart = units[left].start;
            const tokEnd = units[right].end;
            const rawSlice = text.slice(tokStart, tokEnd);

            // Guard against pure 1-char standalone non-emoji punctuation
            if (rawSlice.length === 1 && !STANDALONE_SYMBOL_EMOJIS.has(rawSlice) && !EXOTIC_KAOMOJI_SCRIPT_REGEX.test(rawSlice) && !KAOMOJI_SYMBOL_RANGE_REGEX.test(rawSlice)) {
                continue;
            }
            // Guard against standalone symbol emojis like ♡ or ♪ being misclassified as complex kaomoji
            if (STANDALONE_SYMBOL_EMOJIS.has(rawSlice)) {
                if (!overlapsExisting(tokens, tokStart, tokEnd)) {
                    for (let k = left; k <= right; k++) visitedUnit[k] = true;
                    tokens.push({
                        type: 'emoji',
                        raw: rawSlice,
                        baseRaw: rawSlice,
                        start: tokStart,
                        end: tokEnd,
                        repeatCount: 1
                    });
                }
                idx = right;
                continue;
            }

            if (!overlapsExisting(tokens, tokStart, tokEnd)) {
                for (let k = left; k <= right; k++) visitedUnit[k] = true;
                tokens.push({
                    type: 'kaomoji',
                    raw: rawSlice,
                    baseRaw: rawSlice,
                    start: tokStart,
                    end: tokEnd,
                    repeatCount: 1
                });
            }
            idx = right;
        }

        // Pass 3: Classic ASCII Emoticons with strict boundaries
        for (const emoticon of ASCII_EMOTICONS_ORDERED) {
            let from = 0;
            while (from < text.length) {
                const pos = text.indexOf(emoticon, from);
                if (pos === -1) break;
                const end = pos + emoticon.length;
                from = pos + 1;

                if (overlapsExisting(tokens, pos, end)) continue;

                const before = pos > 0 ? text[pos - 1] : '';
                const after = end < text.length ? text[end] : '';
                if ((before && ALNUM_REGEX.test(before)) || (after && ALNUM_REGEX.test(after))) {
                    continue;
                }
                // Extra guard for colon emoticons (:3, :), :(, :D, :P, :v) vs timestamps/URLs/speaker labels
                if (emoticon.startsWith(':')) {
                    if (before === '/' || after === '/') continue;
                    // Do not match if directly attached to letters or numbers on either side (already checked) or followed by word without space for :v/:3
                    if (before && /[0-9]/.test(before)) continue;
                }

                tokens.push({
                    type: 'emoticon',
                    raw: emoticon,
                    baseRaw: emoticon,
                    start: pos,
                    end,
                    repeatCount: 1
                });
            }
        }

        tokens.sort((a, b) => a.start - b.start);
        return tokens;
    }

    function normalizeCacheKey(raw) {
        return String(raw || '').trim().replace(/\s+/g, ' ');
    }

    function classifyKaomojiByFeatures(raw, lang = 'vi') {
        const s = String(raw || '');
        const isEn = lang === 'en';
        const scores = {
            crying: 0,
            angry: 0,
            happy: 0,
            blush: 0,
            shock: 0,
            smug: 0,
            hug: 0,
            love: 0,
            sleep: 0
        };

        // Crying / whining indicators (note: ʌ, ︿, ﹏, ╥, ╦, ಥ, ̣, ˚, ۵, 💧, T, Q)
        if (/[╥╦ಥ💧]/.test(s)) scores.crying += 4;
        if (/[̣̥]/.test(s)) scores.crying += 3;
        if (/[ʌ︿﹏皿]/.test(s)) scores.crying += 2;
        if (/[˚ﾟ۵]/.test(s)) scores.crying += 1.5;
        if (/[TQ]/.test(s) && !/[A-Za-z]{2,}/.test(s)) scores.crying += 2;
        if (/[૮ა]/.test(s) && /[ʌ︿﹏˚۵ε]/.test(s)) scores.crying += 2;

        // Angry / table-flip
        if (/[┻┳💢]/.test(s)) scores.angry += 5;
        if (/[╬益皿🔥]/.test(s)) scores.angry += 3;
        if (/╯.*︵/.test(s)) scores.angry += 4;
        if (/[`´]/.test(s) && /[Дд益皿_]/.test(s)) scores.angry += 2;

        // Happy / joyful / cute
        if (/[≧≦ᴗ▽∀◡✿✧♪♫]/.test(s)) scores.happy += 2.5;
        if (/[ω]/.test(s) && !/[ʌ︿╥ಥ]/.test(s)) scores.happy += 2;
        if (/\^/.test(s) && !/[T_]/.test(s)) scores.happy += 1.5;
        if (/[ε3]/.test(s) && /[♡♥❤]/.test(s)) scores.love += 3;

        // Blush / shy
        if (/[⁄˶〃ꈍ]/.test(s)) scores.blush += 3.5;
        if (/\/\/\//.test(s)) scores.blush += 3;

        // Shocked / stunned
        if (/[⊙〇Д]/.test(s)) scores.shock += 3.5;
        if (/[°□]/.test(s) && !/[┻┳]/.test(s)) scores.shock += 2;
        if (/O_O|0_0|o_o/i.test(s)) scores.shock += 3.5;

        // Smug / helpless / deadpan
        if (/[￣¬—]/.test(s)) scores.smug += 2.5;
        if (/[=_]{2,}|-_-/.test(s)) scores.smug += 3;
        if (/╮.*╭/.test(s)) scores.smug += 3.5;

        // Hugging / cheering
        if (/[つづっو٩۶୧]/.test(s)) scores.hug += 3;

        // Love
        if (/[♡♥❤💕💖]/.test(s)) scores.love += 4;

        // Sleepy / tired
        if (/z{2,}|Z{2,}/.test(s)) scores.sleep += 4;

        let bestCat = 'default';
        let bestScore = 0;
        for (const [cat, val] of Object.entries(scores)) {
            if (val > bestScore) {
                bestScore = val;
                bestCat = cat;
            }
        }

        const table = {
            crying: { vi: 'mếu máo khóc lóc', en: 'teary crying' },
            angry: { vi: 'tức giận hầm hầm', en: 'angry outburst' },
            happy: { vi: 'vui vẻ rạng rỡ', en: 'happy cheerful expression' },
            blush: { vi: 'ngượng ngùng đỏ mặt', en: 'blushing shyly' },
            shock: { vi: 'ngạc nhiên sửng sốt', en: 'shocked surprise' },
            smug: { vi: 'bất lực cạn lời', en: 'helpless deadpan' },
            hug: { vi: 'hào hứng khích lệ', en: 'cheering excitedly' },
            love: { vi: 'trìu mến yêu thương', en: 'affectionate love' },
            sleep: { vi: 'buồn ngủ mệt mỏi', en: 'sleepy and tired' },
            default: { vi: 'cảm xúc', en: 'emotion' }
        };

        return (table[bestCat] || table.default)[isEn ? 'en' : 'vi'];
    }

    function normalizeCustomIconsMap(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
        for (const [rawKey, val] of Object.entries(raw)) {
            const key = normalizeCacheKey(rawKey);
            if (!key) continue;
            let meaning = '';
            let skip = false;
            let updatedAt = 0;
            if (typeof val === 'string') {
                meaning = val.trim().slice(0, 80);
            } else if (val && typeof val === 'object' && !Array.isArray(val)) {
                skip = Boolean(val.skip);
                const rawMeaning = typeof val.meaning === 'string'
                    ? val.meaning
                    : (typeof val.text === 'string' ? val.text : '');
                meaning = rawMeaning.trim().slice(0, 80);
                updatedAt = Number(val.updatedAt) || 0;
            }
            if (!skip && !meaning) continue;
            out[key] = { meaning, skip, updatedAt };
        }
        return out;
    }

    function lookupCustomIcon(customIcons, raw, baseRaw) {
        if (!customIcons || typeof customIcons !== 'object') return null;
        const candidates = [];
        const pushCand = (s) => {
            if (typeof s === 'string' && s && !candidates.includes(s)) {
                candidates.push(s);
            }
        };

        const rawStr = String(raw || '');
        const baseStr = String(baseRaw || rawStr);
        const normRaw = normalizeCacheKey(rawStr);
        const normBase = normalizeCacheKey(baseStr);
        const noVsBase = baseStr.replace(/\uFE0F/g, '');
        const withVsBase = noVsBase ? `${noVsBase}\uFE0F` : '';
        const noVsRaw = rawStr.replace(/\uFE0F/g, '');

        pushCand(rawStr);
        pushCand(normRaw);
        pushCand(baseStr);
        pushCand(normBase);
        pushCand(noVsBase);
        pushCand(withVsBase);
        pushCand(noVsRaw);
        pushCand(normRaw.toLowerCase());
        pushCand(normBase.toLowerCase());

        for (const cand of candidates) {
            const entry = Object.prototype.hasOwnProperty.call(customIcons, cand) ? customIcons[cand] : null;
            if (!entry) continue;
            if (typeof entry === 'string') {
                const m = entry.trim();
                if (m) return { meaning: m, skip: false };
            } else if (typeof entry === 'object') {
                const skip = Boolean(entry.skip);
                const m = typeof entry.meaning === 'string'
                    ? entry.meaning.trim()
                    : (typeof entry.text === 'string' ? entry.text.trim() : '');
                if (skip || m) {
                    return { meaning: m, skip };
                }
            }
        }
        return null;
    }

    function lookupLearnedCache(learnedCache, rawKey, lang) {
        if (!learnedCache || typeof learnedCache !== 'object') return '';
        const normKey = normalizeCacheKey(rawKey);
        const entry = learnedCache[normKey] || learnedCache[rawKey];
        if (!entry) return '';
        if (typeof entry === 'string') return entry.trim();
        if (typeof entry === 'object') {
            const val = entry[lang] || entry.vi || entry.en || '';
            return typeof val === 'string' ? val.trim() : '';
        }
        return '';
    }

    function resolveLocalIconMeaning(token, options = {}) {
        const lang = options.lang === 'en' ? 'en' : 'vi';
        const learnedCache = options.learnedCache || null;
        const customIcons = options.customIcons || null;
        const raw = token.raw || '';
        const baseRaw = token.baseRaw || raw;

        // 0. User custom library (highest priority, supports per-icon skip)
        const custom = lookupCustomIcon(customIcons, raw, baseRaw);
        if (custom) {
            if (custom.skip) {
                return { meaning: '', skip: true, source: 'custom', confident: true };
            }
            return { meaning: custom.meaning, skip: false, source: 'custom', confident: true };
        }

        // 1. Learned cache (from previous AI calls)
        const cached = lookupLearnedCache(learnedCache, raw, lang) || lookupLearnedCache(learnedCache, baseRaw, lang);
        if (cached) {
            return { meaning: cached, skip: false, source: 'cache', confident: true };
        }

        // 2. Built-in Emoji dictionary
        if (token.type === 'emoji') {
            const cleanedKey = baseRaw.replace(/\uFE0F/g, '');
            const dictEntry = EMOJI_DICT[baseRaw] || EMOJI_DICT[cleanedKey];
            if (dictEntry) {
                let meaning = dictEntry[lang] || dictEntry.vi;
                if ((token.repeatCount || 1) >= 3) {
                    meaning = lang === 'en' ? `${meaning} intensely` : `${meaning} dữ dội`;
                }
                return { meaning, skip: false, source: 'dict', confident: true };
            }
            return {
                meaning: lang === 'en' ? 'emotion' : 'cảm xúc',
                skip: false,
                source: 'heuristic',
                confident: false
            };
        }

        // 3. Built-in ASCII Emoticon / Classic Kaomoji dictionary
        const normLower = normalizeCacheKey(raw).toLowerCase();
        const dictKaomoji = KAOMOJI_DICT[normLower] || KAOMOJI_DICT[raw.trim().toLowerCase()];
        if (dictKaomoji) {
            return {
                meaning: dictKaomoji[lang] || dictKaomoji.vi,
                skip: false,
                source: 'dict',
                confident: true
            };
        }

        // 4. Tier 3 Structural Feature Heuristic
        return {
            meaning: classifyKaomojiByFeatures(raw, lang),
            skip: false,
            source: 'heuristic',
            confident: false
        };
    }

    function capitalizeFirst(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    function formatIconPhrase(meaning, options = {}) {
        const cleanMeaning = String(meaning || '').trim();
        if (!cleanMeaning) return '';
        const style = options.style === 'natural' ? 'natural' : 'tagged';
        const lang = options.lang === 'en' ? 'en' : 'vi';
        const standalone = Boolean(options.standalone);

        if (style === 'tagged') {
            // Avoid double "biểu cảm biểu cảm"
            if (lang === 'en') {
                if (/^expression\b/i.test(cleanMeaning)) {
                    return standalone ? capitalizeFirst(cleanMeaning) : cleanMeaning;
                }
                return standalone ? `Expression: ${cleanMeaning}` : `expression: ${cleanMeaning}`;
            }
            if (/^biểu cảm\b/i.test(cleanMeaning)) {
                return standalone ? capitalizeFirst(cleanMeaning) : cleanMeaning;
            }
            return standalone ? `Biểu cảm ${cleanMeaning}` : `biểu cảm ${cleanMeaning}`;
        }

        return standalone ? capitalizeFirst(cleanMeaning) : cleanMeaning;
    }

    function stripResidualIcons(text, options = {}) {
        let s = String(text || '');
        if (!s) return '';

        const isCjkProse = options.isCjkProse !== undefined ? Boolean(options.isCjkProse) : isCjkProseText(s);

        // Remove any remaining detected icon/kaomoji/emoji tokens cleanly
        const residual = detectIcons(s, { isCjkProse });
        if (residual.length > 0) {
            let out = '';
            let cursor = 0;
            for (const tok of residual) {
                out += s.slice(cursor, tok.start);
                cursor = tok.end;
            }
            out += s.slice(cursor);
            s = out;
        }

        // Also strip stray lone emoji/exotic kaomoji chars that might remain isolated
        s = s
            .replace(EMOJI_SEQUENCE_REGEX, ' ')
            .replace(/[\u0250-\u02FF\u1D00-\u1DBF\u2500-\u25FF\u2600-\u27BF\u2900-\u2BFF\u2E00-\u2E7F\uFE30-\uFE4F\u0966-\u096F\u06F5\u0669\u06F6\u0665]/gu, (m, offset, str) => {
                // Keep math/unit degrees like 38°C or 90° or m²
                const prev = offset > 0 ? str[offset - 1] : '';
                const next = offset + m.length < str.length ? str[offset + m.length] : '';
                if (m === '°' && (/[0-9]/.test(prev) || /^[CFK]$/.test(next))) return m;
                if ((m === '²' || m === '³' || m === '¹') && /[0-9a-zA-Z]/.test(prev)) return m;
                if (MATH_UNIT_GUARD_CHARS.has(m) && (/[0-9]/.test(prev) || /[0-9]/.test(next))) return m;
                return ' ';
            })
            .replace(/[\p{Script=Gujarati}\p{Script=Georgian}\p{Script=Lao}\p{Script=Khmer}\p{Script=Tibetan}\p{Script=Canadian_Aboriginal}\p{Script=Cherokee}\p{Script=Myanmar}\p{Script=Sinhala}\p{Script=Malayalam}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Oriya}\p{Script=Bengali}\p{Script=Tagalog}\p{Script=Hanunoo}\p{Script=Yi}\p{Script=Bopomofo}\p{Script=Tai_Le}\p{Script=Tai_Tham}]/gu, ' ');

        // Clean broken punctuation / spacing left after stripping
        s = s
            .replace(/\s+([,.!?;:])/g, '$1')
            .replace(/:\s*([,.!?]|$)/g, '$1')
            .replace(/,\s*,+/g, ', ')
            .replace(/\s{2,}/g, ' ')
            .replace(/^[,\s:;]+/, '')
            .trim();

        return s;
    }

    function assembleReplacedText(rawText, tokens, phrases) {
        let out = '';
        let cursor = 0;

        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            const phrase = phrases[i] || '';
            const before = rawText.slice(cursor, tok.start);
            const afterPreview = rawText.slice(tok.end);
            const hasWordsBefore = /[\p{L}\p{N}]/u.test(rawText.slice(0, tok.start));
            const hasWordsAfter = /[\p{L}\p{N}]/u.test(afterPreview);

            if (!phrase) {
                out += before;
                cursor = tok.end;
                continue;
            }

            // Smooth separator when line uses speaker colon before icon: `Cô con gái: <icon>` -> `Cô con gái, biểu cảm ...`
            const colonTailMatch = before.match(/\s*:\s*$/);
            if (colonTailMatch && hasWordsBefore) {
                out += before.slice(0, before.length - colonTailMatch[0].length) + ', ' + phrase;
            } else {
                const trimmedBefore = before.replace(/\s+$/, '');
                if (trimmedBefore.length > 0 && !/[(\[{"'“‘]$/.test(trimmedBefore)) {
                    const lastChar = trimmedBefore[trimmedBefore.length - 1];
                    if (/[.!?,;:]/.test(lastChar)) {
                        out += trimmedBefore + ' ' + phrase;
                    } else {
                        out += trimmedBefore + ', ' + phrase;
                    }
                } else {
                    out += before + phrase;
                }
            }

            if (hasWordsAfter && !/^\s*[,.!?;:\])}"'”’]/.test(afterPreview)) {
                out += ', ';
            }
            cursor = tok.end;
        }
        out += rawText.slice(cursor);

        return out
            .replace(/,\s*([,.!?;:])/g, '$1')
            .replace(/,\s*,+/g, ', ')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    function prepareTextForTTS(rawText, options = {}) {
        const raw = String(rawText || '');
        const mode = ['auto', 'local', 'off'].includes(options.mode) ? options.mode : 'auto';
        const style = options.style === 'natural' ? 'natural' : 'tagged';
        const lang = options.lang || detectLanguage(raw, options.fallbackLocale || 'vi');
        const learnedCache = options.learnedCache || null;
        const customIcons = options.customIcons || null;
        const isCjkProse = isCjkProseText(raw);

        if (!raw.trim() || isDecorativeSeparatorLine(raw, customIcons)) {
            return {
                text: '',
                rawText: raw,
                aiText: '',
                hasIcons: false,
                needsAi: false,
                tokens: [],
                aiTokens: [],
                lang
            };
        }

        const tokens = detectIcons(raw, { isCjkProse, customIcons });
        if (tokens.length === 0) {
            return {
                text: raw,
                rawText: raw,
                aiText: raw,
                hasIcons: false,
                needsAi: false,
                tokens: [],
                aiTokens: [],
                lang
            };
        }

        if (mode === 'off') {
            return {
                text: stripResidualIcons(raw, { isCjkProse }),
                rawText: raw,
                aiText: raw,
                hasIcons: true,
                needsAi: false,
                tokens,
                aiTokens: [],
                lang
            };
        }

        const resolved = tokens.map((tok) => resolveLocalIconMeaning(tok, { lang, learnedCache, customIcons }));

        // Strip skipped tokens while building clean aiText and exact shifted token spans
        let workingText = '';
        let srcCursor = 0;
        const activeTokens = [];
        const activeResolved = [];
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            workingText += raw.slice(srcCursor, tok.start);
            if (resolved[i].skip) {
                const prevCh = workingText.slice(-1);
                const nextCh = raw.slice(tok.end, tok.end + 1);
                if (prevCh && nextCh && !/\s/.test(prevCh) && !/[\s,.!?;:]/.test(nextCh)) {
                    workingText += ' ';
                }
            } else {
                const newStart = workingText.length;
                workingText += raw.slice(tok.start, tok.end);
                const newEnd = workingText.length;
                activeTokens.push({ ...tok, start: newStart, end: newEnd });
                activeResolved.push(resolved[i]);
            }
            srcCursor = tok.end;
        }
        workingText += raw.slice(srcCursor);

        const aiText = workingText.replace(/\s{2,}/g, ' ').trim();
        if (activeTokens.length === 0) {
            const textWithoutSkipped = stripResidualIcons(workingText, { isCjkProse });
            return {
                text: textWithoutSkipped,
                rawText: raw,
                aiText: textWithoutSkipped,
                hasIcons: true,
                needsAi: false,
                tokens,
                aiTokens: [],
                lang,
                resolved
            };
        }

        const nonIconContent = workingText
            .split('')
            .filter((_, idx) => !activeTokens.some((t) => idx >= t.start && idx < t.end))
            .join('');
        const isStandaloneOnly = !/[\p{L}\p{N}]/u.test(nonIconContent);

        const phrases = activeResolved.map((res, idx) => formatIconPhrase(res.meaning, {
            style,
            lang,
            standalone: isStandaloneOnly && idx === 0
        }));

        const assembled = assembleReplacedText(workingText, activeTokens, phrases);
        const finalClean = stripResidualIcons(assembled, { isCjkProse });
        const needsAi = mode === 'auto' && activeResolved.some((r) => !r.confident);

        return {
            text: finalClean,
            rawText: raw,
            aiText,
            hasIcons: true,
            needsAi,
            tokens,
            aiTokens: activeTokens,
            lang,
            resolved
        };
    }

    function getDefaultIconEntries(lang = 'vi') {
        const safeLang = lang === 'en' ? 'en' : 'vi';
        const entries = [];
        const emojiByBase = new Map();

        for (const [key, info] of Object.entries(EMOJI_DICT)) {
            const base = key.replace(/\uFE0F/g, '');
            const existing = emojiByBase.get(base);
            // Prefer variation-selector presentation key (e.g. ❤️ over ❤) when both exist
            if (!existing || (key.includes('\uFE0F') && !existing.key.includes('\uFE0F'))) {
                emojiByBase.set(base, {
                    key,
                    meaning: info[safeLang] || info.vi || '',
                    category: 'emoji'
                });
            }
        }
        for (const item of emojiByBase.values()) {
            entries.push(item);
        }
        for (const [key, info] of Object.entries(KAOMOJI_DICT)) {
            entries.push({
                key,
                meaning: info[safeLang] || info.vi || '',
                category: 'kaomoji'
            });
        }
        return entries;
    }

    /**
     * Classify an icon / symbol / kaomoji key as 'emoji' or 'kaomoji' for UI filtering and grouping.
     */
    function classifyIconCategory(rawKey) {
        const key = normalizeCacheKey(rawKey);
        if (!key) return 'kaomoji';
        const noVs = key.replace(/\uFE0F/g, '');
        const withVs = noVs ? `${noVs}\uFE0F` : '';
        if (Object.prototype.hasOwnProperty.call(EMOJI_DICT, key)
            || Object.prototype.hasOwnProperty.call(EMOJI_DICT, noVs)
            || (withVs && Object.prototype.hasOwnProperty.call(EMOJI_DICT, withVs))
            || STANDALONE_SYMBOL_EMOJIS.has(key)
            || STANDALONE_SYMBOL_EMOJIS.has(noVs)) {
            return 'emoji';
        }
        const remainder = key
            .replace(EMOJI_SEQUENCE_REGEX, '')
            .replace(/[#*0-9]\uFE0F?\u20E3/g, '')
            .replace(/\s+/g, '');
        if (!remainder) return 'emoji';
        let stripped = '';
        for (const ch of Array.from(remainder)) {
            if (ch === '\uFE0F' || ch === '\uFE0E' || STANDALONE_SYMBOL_EMOJIS.has(ch)) continue;
            stripped += ch;
        }
        return stripped ? 'kaomoji' : 'emoji';
    }

    function buildAiIconPrompt(items, options = {}) {
        const style = options.style === 'natural' ? 'natural' : 'tagged';
        const lang = options.lang === 'en' ? 'en' : 'vi';
        const isEn = lang === 'en';

        const systemPrompt = isEn
            ? [
                'You convert emoji, emoticons, and kaomoji in web-novel lines into brief spoken descriptions for Text-to-Speech (TTS).',
                'Return STRICT JSON ONLY with no markdown fences or extra commentary:',
                '{"results":[{"id":0,"spoken":"...","icon_gloss":{"<exact_icon>":"<2-6 word emotion phrase>"}}]}',
                'Rules:',
                '1. Keep all original character names, dialogue, and prose words intact.',
                style === 'tagged'
                    ? '2. Use a clear separated tag format ("expression: <brief description>"), e.g. `Daughter: ૮ε˚۵...3˚ა` -> `Daughter, expression: crying pitifully.`'
                    : '2. Weave the emotion smoothly into narrative prose without using the word "expression:", e.g. `Daughter: ૮ε˚۵...3˚ა` -> `Daughter cries pitifully.`',
                '3. Use the `prev` and `next` lines to judge the exact emotional tone (crying vs. laughing vs. blushing vs. angry).',
                '4. `spoken` MUST contain ONLY normal speakable words and punctuation — ZERO emoji, ZERO kaomoji, ZERO foreign symbols.'
            ].join('\n')
            : [
                'Bạn chuyển đổi emoji, emoticon và kaomoji trong truyện chữ sang mô tả ngắn gọn để hệ thống Text-to-Speech (TTS) đọc thành tiếng tự nhiên.',
                'CHỈ trả về JSON hợp lệ duy nhất, KHÔNG bọc markdown ``` và KHÔNG giải thích thêm:',
                '{"results":[{"id":0,"spoken":"...","icon_gloss":{"<icon_gốc>":"<cụm mô tả ngắn 2-6 từ>"}}]}',
                'Quy tắc bắt buộc:',
                '1. Giữ nguyên toàn bộ tên nhân vật, lời thoại và chữ gốc trong câu; chỉ thay phần icon/kaomoji.',
                style === 'tagged'
                    ? '2. Văn phong TÁCH BẠCH có nhãn: dùng cụm "biểu cảm <mô tả ngắn>" tách nhẹ bằng dấu phẩy (nếu cả dòng chỉ có icon thì viết "Biểu cảm <mô tả>"). Ví dụ: `Cô con gái: ૮ε˚۵...3˚ა` -> `Cô con gái, biểu cảm mếu máo khóc nấc.`'
                    : '2. Văn phong TỰ NHIÊN: lồng mượt vào lời kể, KHÔNG dùng chữ "biểu cảm". Ví dụ: `Cô con gái: ૮ε˚۵...3˚ა` -> `Cô con gái mếu máo khóc nức nở.`',
                '3. Dựa vào ngữ cảnh `prev` (câu trước) và `next` (câu sau) để đoán đúng cảm xúc của kaomoji.',
                '4. Trường `spoken` CHỈ chứa chữ tiếng Việt và dấu câu thông thường — TUYỆT ĐỐI KHÔNG chứa emoji, kaomoji hay ký tự ngoại lai.'
            ].join('\n');

        const payloadItems = (Array.isArray(items) ? items : []).map((it) => ({
            id: it.id,
            prev: String(it.prev || '').slice(0, 240),
            text: String(it.text || '').slice(0, 500),
            next: String(it.next || '').slice(0, 240),
            icons: Array.isArray(it.icons) ? it.icons.slice(0, 8) : []
        }));

        const userMessage = JSON.stringify({ style, lang, items: payloadItems });
        return { systemPrompt, userMessage };
    }

    function parseAiIconResponse(rawContent) {
        if (!rawContent || typeof rawContent !== 'string') return null;
        let cleaned = rawContent.trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            cleaned = cleaned.slice(firstBrace, lastBrace + 1);
        }

        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            return null;
        }

        const list = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed?.results) ? parsed.results : null);
        if (!list) return null;

        const out = [];
        for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const id = Number(item.id);
            if (!Number.isFinite(id)) continue;
            const spoken = typeof item.spoken === 'string' ? item.spoken.trim() : '';
            const glossObj = {};
            if (item.icon_gloss && typeof item.icon_gloss === 'object' && !Array.isArray(item.icon_gloss)) {
                for (const [k, v] of Object.entries(item.icon_gloss)) {
                    const normK = normalizeCacheKey(k);
                    if (normK && typeof v === 'string') {
                        const cleanV = stripResidualIcons(v).trim();
                        if (cleanV && cleanV.length <= 60) {
                            glossObj[normK] = cleanV;
                        }
                    }
                }
            }
            out.push({ id, spoken, icon_gloss: glossObj });
        }
        return out;
    }

    function sanitizeAiSpokenText(aiSpoken, rawText, fallbackText, options = {}) {
        const fb = String(fallbackText || '').trim();
        if (!aiSpoken || typeof aiSpoken !== 'string') return fb;

        const isCjkProse = isCjkProseText(rawText || '');
        const cleanSpoken = stripResidualIcons(aiSpoken, { isCjkProse });
        if (!cleanSpoken || !/[\p{L}\p{N}]/u.test(cleanSpoken)) {
            return fb;
        }

        const iconCount = Math.max(1, Number(options.iconCount) || 1);
        const maxAllowedLen = Math.max(180, String(rawText || '').length + iconCount * 100 + 60);
        if (cleanSpoken.length > maxAllowedLen) {
            return fb;
        }

        // Guard against hallucination dropping original prose words (e.g. speaker name "Cô con gái")
        const rawTokens = detectIcons(rawText || '', { isCjkProse });
        let nonIconRaw = String(rawText || '');
        if (rawTokens.length > 0) {
            let acc = '';
            let cur = 0;
            for (const tok of rawTokens) {
                acc += nonIconRaw.slice(cur, tok.start);
                cur = tok.end;
            }
            acc += nonIconRaw.slice(cur);
            nonIconRaw = acc;
        }
        const origWords = (nonIconRaw.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);
        if (origWords.length > 0) {
            const lowerOut = cleanSpoken.toLowerCase();
            let matched = 0;
            for (const w of origWords) {
                if (lowerOut.includes(w)) matched += 1;
            }
            if (matched / origWords.length < 0.5) {
                return fb;
            }
        }

        return cleanSpoken;
    }

    return {
        EMOJI_DICT,
        KAOMOJI_DICT,
        detectLanguage,
        isCjkProseText,
        isDecorativeSeparatorLine,
        detectIcons,
        normalizeCacheKey,
        normalizeCustomIconsMap,
        lookupCustomIcon,
        getDefaultIconEntries,
        classifyIconCategory,
        classifyKaomojiByFeatures,
        resolveLocalIconMeaning,
        formatIconPhrase,
        stripResidualIcons,
        prepareTextForTTS,
        buildAiIconPrompt,
        parseAiIconResponse,
        sanitizeAiSpokenText
    };
});

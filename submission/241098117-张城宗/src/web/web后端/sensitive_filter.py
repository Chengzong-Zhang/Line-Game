from __future__ import annotations

import asyncio
import random
import unicodedata
from collections import deque
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Iterable, Optional


class UIStyle(str, Enum):
    ACADEMIC = "academic"
    CASUAL = "casual"


_STYLE_MESSAGES = {
    UIStyle.ACADEMIC: {
        "error": "IDENTIFIER_CONSTRAINT_VIOLATION",
        "term": "Identifier Constraint Violation",
        "message": "检测到非法的标识符分量：[{masked_word}]，请符合学术命名规范。",
        "corrected_message": "检测到非法的标识符分量：[{masked_word}]，已根据学术命名规范自动分配标识符。",
    },
    UIStyle.CASUAL: {
        "error": "NICKNAME_BLOCKED",
        "term": "Nickname Blocked",
        "message": "昵称包含敏感词汇：[{masked_word}]，换一个试试吧！",
        "corrected_message": "昵称包含敏感词汇：[{masked_word}]，已根据命名规范自动分配昵称。",
    },
}


@dataclass(frozen=True)
class SensitiveWord:
    original: str
    normalized: str

    @property
    def masked(self) -> str:
        return SensitiveFilter.mask_word(self.original)


@dataclass(frozen=True)
class FilterResult:
    allowed: bool
    original: str
    normalized: str
    ui_style: UIStyle
    matched_word: Optional[SensitiveWord] = None
    replacement: Optional[str] = None

    @property
    def error(self) -> str:
        return _STYLE_MESSAGES[self.ui_style]["error"]

    @property
    def term(self) -> str:
        return _STYLE_MESSAGES[self.ui_style]["term"]

    @property
    def message(self) -> str:
        return _STYLE_MESSAGES[self.ui_style]["message"].format(masked_word=self.masked_word)

    @property
    def corrected_message(self) -> str:
        return _STYLE_MESSAGES[self.ui_style]["corrected_message"].format(masked_word=self.masked_word)

    @property
    def offending_word(self) -> str:
        return self.matched_word.original if self.matched_word else ""

    @property
    def masked_word(self) -> str:
        return self.matched_word.masked if self.matched_word else ""

    def error_context(self) -> dict[str, str]:
        return {
            "sensitive_filter": "true",
            "error": self.error,
            "term": self.term,
            "message": self.message,
            "ui_style": self.ui_style.value,
            "matched_word": self.offending_word,
            "masked_word": self.masked_word,
            "normalized": self.normalized,
            "suggestion": self.replacement or SensitiveFilter.replacement_name(self.ui_style),
        }


class SensitiveFilter:
    """
    Aho-Corasick DFA for high-throughput nickname checks.

    Matching stays linear in the normalized nickname length:
    O(len(normalized_text) + emitted_matches).
    """

    _LEET_MAP = str.maketrans(
        {
            "0": "o",
            "1": "i",
            "!": "i",
            "|": "i",
            "3": "e",
            "4": "a",
            "@": "a",
            "5": "s",
            "$": "s",
            "7": "t",
            "+": "t",
            "8": "b",
            "9": "g",
        }
    )
    _RANDOM = random.SystemRandom()

    def __init__(self) -> None:
        self._goto: list[dict[str, int]] = [{}]
        self._fail: list[int] = [0]
        self._output: list[list[SensitiveWord]] = [[]]
        self._words: dict[str, SensitiveWord] = {}
        self._load_lock = asyncio.Lock()

    @property
    def word_count(self) -> int:
        return len(self._words)

    def masked_words(self) -> list[str]:
        return sorted(word.masked for word in self._words.values())

    async def load_from_file(self, file_path: str | Path) -> None:
        path = Path(file_path)
        if not path.exists():
            self.load_words(())
            return

        text = await asyncio.to_thread(path.read_text, encoding="utf-8")
        words = []
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            word = line.split("#", 1)[0].strip()
            if word:
                words.append(word)

        async with self._load_lock:
            self.load_words(words)

    def load_words(self, words: Iterable[str]) -> None:
        normalized_words: dict[str, SensitiveWord] = {}
        for word in words:
            original = str(word).strip()
            normalized = self.normalize(original)
            if normalized and normalized not in normalized_words:
                normalized_words[normalized] = SensitiveWord(
                    original=original,
                    normalized=normalized,
                )

        goto: list[dict[str, int]] = [{}]
        fail: list[int] = [0]
        output: list[list[SensitiveWord]] = [[]]

        for word, sensitive_word in sorted(normalized_words.items()):
            state = 0
            for char in word:
                next_state = goto[state].get(char)
                if next_state is None:
                    next_state = len(goto)
                    goto[state][char] = next_state
                    goto.append({})
                    fail.append(0)
                    output.append([])
                state = next_state
            output[state].append(sensitive_word)

        queue: deque[int] = deque()
        for next_state in goto[0].values():
            queue.append(next_state)
            fail[next_state] = 0

        while queue:
            state = queue.popleft()
            for char, next_state in goto[state].items():
                queue.append(next_state)
                fallback = fail[state]
                while fallback and char not in goto[fallback]:
                    fallback = fail[fallback]
                fail[next_state] = goto[fallback].get(char, 0)
                output[next_state].extend(output[fail[next_state]])

        for matches in output:
            matches.sort(key=lambda item: len(item.normalized), reverse=True)

        self._goto = goto
        self._fail = fail
        self._output = output
        self._words = normalized_words

    def validate(
        self,
        nickname: str,
        ui_style: str | UIStyle = UIStyle.CASUAL,
        auto_correct: bool = False,
    ) -> FilterResult:
        style = self.resolve_style(ui_style)
        normalized = self.normalize(nickname)
        matched_word = self.find_first(normalized)
        if matched_word is None:
            return FilterResult(
                allowed=True,
                original=nickname,
                normalized=normalized,
                ui_style=style,
            )

        replacement = self.replacement_name(style) if auto_correct else None
        return FilterResult(
            allowed=False,
            original=nickname,
            normalized=normalized,
            ui_style=style,
            matched_word=matched_word,
            replacement=replacement,
        )

    def find_first(self, normalized_text: str) -> Optional[SensitiveWord]:
        if not self._words or not normalized_text:
            return None

        state = 0
        for char in normalized_text:
            while state and char not in self._goto[state]:
                state = self._fail[state]
            state = self._goto[state].get(char, 0)
            if self._output[state]:
                return self._output[state][0]
        return None

    @classmethod
    def normalize(cls, text: str) -> str:
        normalized = unicodedata.normalize("NFKC", str(text)).casefold()
        normalized = normalized.translate(cls._LEET_MAP)

        chars: list[str] = []
        for char in normalized:
            category = unicodedata.category(char)
            if category[0] in {"C", "M", "P", "S", "Z"}:
                continue
            if category[0] in {"L", "N"}:
                chars.append(char)
        return "".join(chars)

    @classmethod
    def mask_word(cls, word: str) -> str:
        normalized = cls.normalize(word)
        if not normalized:
            return ""
        if len(normalized) <= 2:
            return f"{normalized[0]}*"
        return f"{normalized[0]}{'*' * max(3, len(normalized) - 2)}{normalized[-1]}"

    @staticmethod
    def resolve_style(ui_style: str | UIStyle) -> UIStyle:
        if isinstance(ui_style, UIStyle):
            return ui_style
        try:
            return UIStyle(str(ui_style).casefold())
        except ValueError:
            return UIStyle.CASUAL

    @classmethod
    def replacement_name(cls, ui_style: str | UIStyle = UIStyle.CASUAL) -> str:
        style = cls.resolve_style(ui_style)
        if style == UIStyle.ACADEMIC:
            return f"Anonymous_Scholar_{cls._RANDOM.randint(1000, 9999)}"
        return f"Node_Alpha_Ref_{cls._RANDOM.randint(1000, 9999)}"

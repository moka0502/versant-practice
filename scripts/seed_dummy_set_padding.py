"""既存の実問題(data/problems.yaml)を壊さずに、ダミー問題を追記してセット数を増やすスクリプト。

バックログNo.3.5（セット選択式出題）のUI・ロジックを、実データが足りない今のうちに
検証できるようにするための一時的な水増し。各レベルの実問題(set_number=1)に加えて、
ダミー問題をset_number=2・3として16問ずつ追加し、計3セット/レベルにする。

ダミー問題はsource="dummy_set_padding"・verified=False（音声judgeを通していないため
正直にFalse）で追加する。scripts/export_to_prototype.py側でこのsourceだけは
音声ファイル無しでもエクスポート対象にする特例処理をしている。

実データが増えたら、ダミーセットは実データに順次差し替えていく想定。

実行: python scripts/seed_dummy_set_padding.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # PYTHONPATH無しでも実行できるように

from versant_practice.difficulty import classify_difficulty, count_words
from versant_practice.models import Problem
from versant_practice.yaml_io import dump_problems, load_problems

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "problems.yaml"

DUMMY_SOURCE = "dummy_set_padding"

# 各レベル32文（set_number=2用16文 + set_number=3用16文）。
# classify_difficulty(word_count)がキーのレベルと一致する語数で書いている。
DUMMY_SENTENCES = {
    "beginner": [
        "Please leave the box on the table.",
        "Can you open the window for me?",
        "I will meet you at the station.",
        "She likes to read books at night.",
        "The store closes early on Sundays.",
        "We should leave before it gets dark.",
        "He forgot his umbrella at the office.",
        "Turn left at the next corner, please.",
        "I need to buy some milk today.",
        "The bus was late again this morning.",
        "Could you pass me the salt, please?",
        "They moved to a new apartment last week.",
        "My phone battery died this afternoon.",
        "Let's grab lunch before the meeting starts.",
        "The garden looks lovely in the spring.",
        "I forgot to lock the front door.",
        "Can we reschedule our call to Friday?",
        "The coffee machine is broken again today.",
        "Please remember to bring your ID card.",
        "It started raining right after lunch.",
        "The kids are playing in the backyard.",
        "I left my keys inside the car.",
        "We ran out of paper for the printer.",
        "The meeting starts at ten tomorrow morning.",
        "She always arrives early for work.",
        "Please water the plants while I'm away.",
        "The library is closed on public holidays.",
        "He usually walks his dog every morning.",
        "Can you send me that file again?",
        "The elevator is out of service today.",
        "I need a new charger for my laptop.",
        "Let's take a short break for coffee.",
    ],
    "intermediate": [
        "Could you please confirm whether the shipment will arrive on time?",
        "I was hoping you could review this draft before tomorrow's meeting.",
        "We need to figure out a better way to handle complaints.",
        "The manager asked everyone to submit their reports by Friday afternoon.",
        "She mentioned that the flight might be delayed because of weather.",
        "Let me know if you need any help preparing the presentation.",
        "The new intern is still learning how the system works here.",
        "I think we should double-check the numbers before sending the invoice.",
        "He said the client wants to change the delivery date again.",
        "Our team is planning to launch the new website next month.",
        "Please make sure the printer has enough paper before you leave.",
        "They decided to postpone the trip until the weather gets better.",
        "Would you mind sending me the updated schedule sometime this week?",
        "The company is looking for ways to reduce shipping costs overall.",
        "We should probably call the client before making any final decisions.",
        "I heard that the new policy will take effect next quarter.",
        "Could you check whether the invoice has already been sent out?",
        "The technician said the issue should be fixed by this evening.",
        "Let's set up a quick call to go over the details.",
        "I noticed the numbers in the report don't quite add up.",
        "She's been working on this project since early last month.",
        "We might need to order more supplies before the week ends.",
        "The client asked for a few small changes to the design.",
        "I think we're finally ready to move forward with the plan.",
        "He forgot to attach the file before sending the email earlier.",
        "Can you let the team know about the schedule change today?",
        "The new software update fixed most of the reported bugs already.",
        "We're still waiting to hear back from the vendor about pricing.",
        "I'll send you the notes right after the meeting wraps up.",
        "The office will be closed for renovations next Monday and Tuesday.",
        "Please double check your email before forwarding it to the client.",
        "The delivery is expected to arrive sometime early next week.",
    ],
    "advanced": [
        "The board decided to delay the merger until all regulatory approvals had been granted.",
        "Even though the budget was tight, the team still managed to deliver the project early.",
        "Analysts believe that consumer spending will continue to rise despite ongoing economic uncertainty.",
        "The city council approved a new plan to reduce traffic congestion in the downtown area.",
        "Because the servers were overloaded, customers experienced long delays when trying to check out.",
        "The professor explained that the theory had been widely misunderstood since it was first published.",
        "Although the negotiations lasted several months, both companies eventually reached a mutually beneficial agreement.",
        "The airline announced that all flights would be grounded until the storm had passed safely.",
        "Several employees raised concerns about the new policy during yesterday's all-hands meeting downtown.",
        "The report suggested that the company's profits had grown steadily over the past three years.",
        "Once the renovations are complete, the office will finally have enough space for everyone.",
        "The engineers spent weeks testing the prototype before it was approved for mass production.",
        "Customers were frustrated when the app crashed repeatedly during the busiest hours of the day.",
        "The government announced new regulations aimed at reducing carbon emissions from heavy industry nationwide.",
        "Although the interview went smoothly, she still felt nervous about the final decision.",
        "The committee spent hours debating whether the new policy would actually reduce overall costs.",
        "Investors were relieved when the company reported earnings that exceeded analyst expectations easily.",
        "The volunteers worked through the night to make sure everything was ready by morning.",
        "Because the flight was overbooked, several passengers were offered vouchers for a later departure.",
        "The research team published their findings after nearly two years of careful analysis.",
        "Management assured employees that no layoffs were planned despite the recent restructuring efforts.",
        "The bridge was closed for repairs after inspectors found several cracks in the foundation.",
        "Although sales declined slightly last quarter, executives remain optimistic about the coming year.",
        "The university announced a new scholarship program aimed at supporting first-generation college students.",
        "Weather forecasters warned that the storm could bring significant flooding to coastal areas soon.",
        "The startup secured additional funding after impressing investors with its latest product demo.",
        "Employees were asked to complete the survey before the end of the month.",
        "The factory implemented new safety measures following an inspection earlier in the year.",
        "Critics argued that the film's pacing suffered due to its overly long running time.",
        "The negotiations stalled after both sides failed to agree on key contract terms.",
        "Local officials announced new plans to renovate the old library building next spring.",
        "The airline's new policy requires passengers to check in online before arriving at the airport.",
    ],
}

SETS_PER_LEVEL = 2  # set_number=2, 3 の2セット分を追加（既存実データがset_number=1）
PROBLEMS_PER_SET = 16


def build_dummy_problems() -> list[Problem]:
    problems = []
    counter = 1
    for level, sentences in DUMMY_SENTENCES.items():
        expected = SETS_PER_LEVEL * PROBLEMS_PER_SET
        if len(sentences) != expected:
            raise ValueError(f"{level}: 期待した文数{expected}に対して{len(sentences)}文しかありません")
        for i, text in enumerate(sentences):
            word_count = count_words(text)
            difficulty = classify_difficulty(word_count)
            if difficulty != level:
                raise ValueError(
                    f"{level}用の文の語数({word_count})がclassify_difficultyで"
                    f"'{difficulty}'と判定されました: {text!r}"
                )
            set_number = 2 + (i // PROBLEMS_PER_SET)
            problems.append(
                Problem(
                    id=f"rep-dummy-{counter:04d}",
                    text=text,
                    script_segments=[text],  # ダミーにつきフレーズ区切りはしていない
                    char_count=len(text),
                    word_count=word_count,
                    difficulty=difficulty,
                    audio=[],
                    source=DUMMY_SOURCE,
                    source_ref=f"dummy-set-padding-{counter}",
                    verified=False,
                    set_number=set_number,
                )
            )
            counter += 1
    return problems


def main():
    existing = load_problems(DATA_PATH)
    dummy = build_dummy_problems()
    dump_problems(existing + dummy, DATA_PATH)
    print(f"既存{len(existing)}件はそのまま維持し、ダミー{len(dummy)}件を追加しました → {DATA_PATH}")


if __name__ == "__main__":
    main()

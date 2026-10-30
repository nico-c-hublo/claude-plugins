"""The conductor on MLX, loaded offline from the pinned local checkpoint."""

import laya_mlx

from .checkpoint import SHA256

MODEL_NAME = "laya-conductor"

# The wording the model was fine-tuned on (fine-tune notebook, cell 5). Changing it
# changes what the probabilities mean.
ROLE_QUESTION = {
    "role": {
        "type": "choice",
        "instructions": "How much reasoning effort does this coding request need?",
        "criteria": {
            "smol": "trivial mechanical edit: rename, typo, format, commit message, one-liner, add import",
            "default": "normal coding: implement a well-defined feature, fix a bug with known cause, write a test",
            "slow": "hard: debug an unknown cause, architecture or design, large refactor, security review",
        },
    }
}


class MlxScorer:
    model_name = MODEL_NAME
    ready = True

    def __init__(self, agent):
        self._agent = agent

    def score(self, text, context_tokens):
        state = {"request": text}
        if context_tokens is not None:
            state["context_tokens"] = context_tokens
        return self._agent.predict(state, ROLE_QUESTION)["answers"]["role"]["probabilities"]


def load_scorer(model_dir):
    """Loads and warms the model; refuses a checkpoint that differs from the pins."""
    agent = laya_mlx.load(model_dir, local_files_only=True, expected_sha256=SHA256)
    scorer = MlxScorer(agent)
    # The first calls compile; take that cost here, not on a user's first prompt.
    for text in ("warm up", "warm up " * 50):
        scorer.score(text, None)
    return scorer

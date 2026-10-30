"""The one checkpoint the daemon will load, pinned by revision and file hashes.

A copy that differs by a byte is refused, so the weights cannot be swapped for others.
"""

REPO = "mvilacad/laya-conductor"
REVISION = "04116e6808345ee4aa9477afa5e405cd48ab8421"

# Only the files the loader reads; `checkpoint_latest/` in the repo is a duplicate.
SHA256 = {
    "model.safetensors": "3c8bed1ad91e90151b38fefb3a5625e02307ce491f1eb11659bcdde05e4f1d7e",
    "rl_agent_config.json": "fb80f0674ca476136421c12b6e5fc5622098e3ad2bd6f308b433ebbdc5011b87",
    "encoder/config.json": "4d31981e52fcbf329542b1be74989bd46fcceda83e747ae003ee8dc7a1cc13c6",
    "tokenizer/tokenizer_config.json": "5926e6ec4294f80294bd98d9176defa9fbae7f140525d06a1da987488e74a973",
    "tokenizer/tokenizer.json": "6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30",
}

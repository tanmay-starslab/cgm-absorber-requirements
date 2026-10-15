def pytest_configure(config):
    config.addinivalue_line("markers", "slow: real-data integration tests (yt/trident on the slim cutout)")

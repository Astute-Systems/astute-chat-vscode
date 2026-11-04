CXX = g++
CXXFLAGS = -std=c++11 -Wall -Wextra
TARGET = prime_generator
SRC = prime_generator.cpp

all: $(TARGET)

$(TARGET): $(SRC)
	$(CXX) $(CXXFLAGS) $(SRC) -o $(TARGET)

clean:
	rm -f $(TARGET)

.PHONY: all clean

[  2%] Building CXX object CMakeFiles/coriolis_engine.dir/coralis/src/sdl_gamepad.cpp.o
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:88:15: error: ‘coriolis::GamepadState’ has not been declared
   88 |     bool Read(coriolis::GamepadState* state) const {
      |               ^~~~~~~~
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp: Inmember function ‘void coriolis::SdlGamepad::HandleEvent(const SDL_Event&)’:
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:68:50: error: no match for ‘operator==’ (operand types are ‘const SDL_JoyDeviceEvent’ and ‘Uint32’ {aka ‘unsigned int’})
   68 |             if (pad_ != nullptr && event.jdevice == id_) {
      |                                    ~~~~~~~~~~~~~ ^~ ~~~
      |                                          |          |
      |                                          |          Uint32{aka unsigned int}
      |                                          const SDL_JoyDeviceEvent
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp: Inmember function ‘bool coriolis::SdlGamepad::Read(int*) const’:
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:94:16: error: request for member ‘Set’ in ‘* state’, which is of non-class type ‘int’
   94 |         state->Set(m.leftX, SDL_JoystickGetAxis(pad_, SDL_AXISMOTX));
      |                ^~~
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:94:20: error: ‘m’ was not declared in this scope; did you mean ‘tm’?
   94 |         state->Set(m.leftX, SDL_JoystickGetAxis(pad_, SDL_AXISMOTX));
      |                    ^
      |                    tm
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:94:55: error: ‘SDL_AXISMOTX’ was not declared in this scope
   94 |  state->Set(m.leftX, SDL_JoystickGetAxis(pad_, SDL_AXISMOTX));
      |                                                ^~~~~~~~~~~~
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:95:16: error: request for member ‘Set’ in ‘* state’, which is of non-class type ‘int’
   95 |         state->Set(m.leftY, SDL_JoystickGetAxis(pad_, SDL_AXISMOTY));
      |                ^~~
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:95:55: error: ‘SDL_AXISMOTY’ was not declared in this scope
   95 |  state->Set(m.leftY, SDL_JoystickGetAxis(pad_, SDL_AXISMOTY));
      |                                                ^~~~~~~~~~~~
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:96:16: error: request for member ‘Set’ in ‘* state’, which is of non-class type ‘int’
   96 |         state->Set(m.rightX, SDL_JoystickGetAxis(pad_, SDL_AXISMUCHX));
      |                ^~~
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:96:56: error: ‘SDL_AXISMUCHX’ was not declared in this scope
   96 | state->Set(m.rightX, SDL_JoystickGetAxis(pad_, SDL_AXISMUCHX));
      |                                                ^~~~~~~~~~~~~
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:97:16: error: request for member ‘Set’ in ‘* state’, which is of non-class type ‘int’
   97 |         state->Set(m.rightY, SDL_JoystickGetAxis(pad_, SDL_AXISMUCHY));
      |                ^~~
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:97:56: error: ‘SDL_AXISMUCHY’ was not declared in this scope
   97 | state->Set(m.rightY, SDL_JoystickGetAxis(pad_, SDL_AXISMUCHY));
      |                                                ^~~~~~~~~~~~~
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:102:20: error: request for member ‘Set’ in ‘* state’, which is of non-class type ‘int’
  102 |             state->Set(m.button0, 1);
      |                    ^~~
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:104:20: error: request for member ‘Set’ in ‘* state’, which is of non-class type ‘int’
  104 |             state->Set(m.button0, 0);
      |                    ^~~
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:108:20: error: request for member ‘Set’ in ‘* state’, which is of non-class type ‘int’
  108 |             state->Set(m.button1, 1);
      |                    ^~~
/home/newman/repos/space-paranoids/coralis/src/sdl_gamepad.cpp:110:20: error: request for member ‘Set’ in ‘* state’, which is of non-class type ‘int’
  110 |             state->Set(m.button1, 0);
      |                    ^~~
make[2]: *** [CMakeFiles/coriolis_engine.dir/build.make:415: CMakeFiles/coriolis_engine.dir/coralis/src/sdl_gamepad.cpp.o] Error 1
make[1]: *** [CMakeFiles/Makefile2:90: CMakeFiles/coriolis_engine.dir/all] Error 2
make: *** [Makefile:91: all] Error 2
newman@Legion-Pro-5:~/repos/space-paranoids/build$ 